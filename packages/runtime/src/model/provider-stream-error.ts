// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Observe the structured error event a provider can send inside a 2xx
 * server-sent-event stream, such as
 * `data: {"error":{"code":503,"type":"service_unavailable",...}}`, while the
 * consumer reads the same bytes, in the same chunks, as they arrive.
 *
 * Only closed facts leave this module: the HTTP status the event's integer
 * `error.code` declares, and whether its `error.type` is a known server-fault
 * type. The provider's error text is never read.
 */
import type { ProviderStreamErrorObservation } from "./attempt-telemetry.js";
import { isHttpStatus } from "../records/model-telemetry.js";
import { stripLineByteOrderMark } from "./provider-response-payloads.js";

/** Provider `error.type` values that declare a fault on the provider's side. */
const SERVER_FAULT_ERROR_TYPES: ReadonlySet<string> = new Set([
  // NVIDIA API Catalog chat completions.
  "service_unavailable",
  // OpenAI chat completions.
  "server_error",
  // Anthropic messages.
  "api_error",
  "overloaded_error",
]);

const ERROR_KEY = '"error"';

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Read one event's `data` as a structured provider error, or `undefined` when
 * it is not one. A failing `error.code` outside 400-599, or a string code, is
 * no declared status.
 */
export function readProviderStreamErrorEvent(
  data: string,
): ProviderStreamErrorObservation | undefined {
  // An ordinary chunk carries no `"error"` key; skip parsing it.
  if (!data.includes(ERROR_KEY)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (!isPlainRecord(parsed) || !isPlainRecord(parsed.error)) return undefined;
  const { code, type } = parsed.error;
  const status = isHttpStatus(code) && code >= 400 ? code : undefined;
  return {
    ...(status === undefined ? {} : { status }),
    serverFault: typeof type === "string" && SERVER_FAULT_ERROR_TYPES.has(type),
  };
}

/**
 * Whether one parsed event payload is only a structured provider error: an
 * object `error` with no other member except `type: "error"`, so it carries
 * no model output.
 */
export function isProviderErrorEnvelope(payload: unknown): boolean {
  if (!isPlainRecord(payload) || !isPlainRecord(payload.error)) return false;
  return Object.keys(payload).every(
    (key) => key === "error" || (key === "type" && payload.type === "error"),
  );
}

/** The incremental reader behind {@link observeProviderStreamErrors}. */
export interface ProviderStreamErrorScanner {
  push(chunk: Uint8Array): void;
  /** A complete `[DONE]` event has been read, as the consumer's SDK reads one. */
  readonly doneSeen: boolean;
}

const DATA_FIELD = "data";
const DONE_DATA = "[DONE]";

/**
 * Incremental SSE reader that reports the first structured error event. Only
 * newly decoded text is searched, so the work is linear in the stream. It
 * holds the current event's data lines, as the stream's consumer does, and
 * drops any other field's line once its name is known. It reads lines as the
 * openai SDK does: one leading byte order mark is dropped from every line, and
 * an event is dispatched only at its blank line, so an unterminated event at
 * the end of the stream is discarded. Pi's anthropic-messages parser still
 * delivers such a final event, so on that route a final error event without
 * its blank line goes unobserved. A throwing `onError` never reaches the
 * stream.
 */
export function createProviderStreamErrorScanner(
  onError: (event: ProviderStreamErrorObservation) => void,
): ProviderStreamErrorScanner {
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  const lineEnd = /[\r\n]/gu;
  let line = "";
  let lineStarted = false;
  let field: "undecided" | "data" | "other" = "undecided";
  let skipLeadingLineFeed = false;
  let data: string[] | undefined;
  let reported = false;
  let doneSeen = false;

  const append = (text: string): void => {
    let segment = text;
    if (!lineStarted) {
      if (segment === "") return;
      lineStarted = true;
      segment = stripLineByteOrderMark(segment);
    }
    if (field === "other" || segment === "") return;
    line += segment;
    if (field === "data") return;
    // An undecided line holds at most the field name and one segment.
    const colon = line.indexOf(":");
    const name = colon === -1 ? line : line.slice(0, colon);
    if (colon === -1 && DATA_FIELD.startsWith(name)) return;
    field = name === DATA_FIELD ? "data" : "other";
    if (field === "other") line = "";
  };

  const endLine = (): void => {
    const complete = line;
    const kind = field;
    line = "";
    field = "undecided";
    lineStarted = false;
    if (kind === "other") return;
    if (complete === "") {
      const payload = data?.join("\n");
      data = undefined;
      // The consumer's SDK ends the stream at the first `[DONE]` prefix.
      if (payload?.startsWith(DONE_DATA)) doneSeen = true;
      const event = payload === undefined ? undefined : readProviderStreamErrorEvent(payload);
      if (!event) return;
      reported = true;
      try {
        onError(event);
      } catch {
        // Observation is advisory; the consumer's stream is never affected.
      }
      return;
    }
    if (kind !== "data" && complete !== DATA_FIELD) return;
    const value = complete.slice(DATA_FIELD.length + 1);
    (data ??= []).push(value.startsWith(" ") ? value.slice(1) : value);
  };

  return {
    push(chunk) {
      if (reported) return;
      const text = decoder.decode(chunk, { stream: true });
      // A chunk that ends inside a multi-byte character can decode to nothing.
      if (text === "") return;
      let start = 0;
      // The LF of a CRLF split across chunks ends no second line.
      if (skipLeadingLineFeed && text.startsWith("\n")) start = 1;
      skipLeadingLineFeed = false;
      lineEnd.lastIndex = start;
      for (let match = lineEnd.exec(text); match; match = lineEnd.exec(text)) {
        append(text.slice(start, match.index));
        endLine();
        if (reported) return;
        start = match.index + 1;
        if (match[0] === "\r") {
          if (start === text.length) skipLeadingLineFeed = true;
          else if (text[start] === "\n") start += 1;
        }
        lineEnd.lastIndex = start;
      }
      append(text.slice(start));
    },
    get doneSeen() {
      return doneSeen;
    },
  };
}

/**
 * Pass `response` through unchanged, reporting the first structured error event
 * its body carries, and `onClosedBeforeDone` when the body reaches a clean end
 * with no `[DONE]` event and no error event. Each chunk is scanned and then
 * handed on as-is; nothing is held back, re-encoded, or reordered, and
 * cancellation reaches the source. A body that fails or is cancelled has no
 * clean end.
 */
export function observeProviderStreamErrors(
  response: Response,
  onError: (event: ProviderStreamErrorObservation) => void,
  onClosedBeforeDone?: () => void,
): Response {
  if (!response.body) return response;
  const reader = response.body.getReader();
  let errorSeen = false;
  const scanner = createProviderStreamErrorScanner((event) => {
    errorSeen = true;
    onError(event);
  });
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const chunk = await reader.read();
      if (chunk.done) {
        if (!scanner.doneSeen && !errorSeen) {
          try {
            onClosedBeforeDone?.();
          } catch {
            // Observation is advisory; the consumer's stream is never affected.
          }
        }
        controller.close();
        return;
      }
      scanner.push(chunk.value);
      controller.enqueue(chunk.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
