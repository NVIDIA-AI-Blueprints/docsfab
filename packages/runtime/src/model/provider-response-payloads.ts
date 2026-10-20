// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Read the JSON payloads of a buffered provider response so that the response
 * boundary checks at least every payload a consumer can deliver.
 *
 * Pi's consumers differ: the openai SDK decodes each line on its own, which
 * drops one leading U+FEFF from every line, while Pi's own anthropic-messages
 * parser drops none. Both end a line at CRLF, LF, or a bare CR. This reader
 * ends lines the same way and drops every leading U+FEFF, so it reads every
 * `data:` line either consumer reads, and possibly more.
 */

const BYTE_ORDER_MARK = "\uFEFF";
const LEADING_BYTE_ORDER_MARKS = /^\uFEFF+/u;
const LINE_END = /\r\n|\r|\n/u;
const DATA_PREFIX = "data:";
const DONE = "[DONE]";

/** The JSON payloads of one response body. */
export interface ProviderResponsePayloads {
  /** True when any line is a `data:` field, so the body is read as SSE. */
  readonly stream: boolean;
  readonly payloads: readonly unknown[];
  /** True when a data payload follows the first `[DONE]`. */
  readonly dataAfterDone: boolean;
}

/** Drop the one leading byte order mark that a per-line decode drops. */
export function stripLineByteOrderMark(line: string): string {
  return line.startsWith(BYTE_ORDER_MARK) ? line.slice(BYTE_ORDER_MARK.length) : line;
}

/**
 * Parse every `data:` payload of an SSE body, or the whole body when it has no
 * `data:` line. Returns `undefined` when any payload fails to parse. Each
 * `data:` line is parsed on its own, so a payload split across lines is
 * refused rather than joined.
 */
export function readProviderResponsePayloads(text: string): ProviderResponsePayloads | undefined {
  const lines = text.split(LINE_END).map((line) => line.replace(LEADING_BYTE_ORDER_MARKS, ""));
  const stream = lines.some((line) => line.startsWith(DATA_PREFIX));
  const payloads: unknown[] = [];
  let done = false;
  let dataAfterDone = false;
  try {
    if (!stream) {
      payloads.push(JSON.parse(text));
      return { stream, payloads, dataAfterDone };
    }
    for (const line of lines) {
      if (!line.startsWith(DATA_PREFIX)) continue;
      const data = line.slice(DATA_PREFIX.length).trim();
      if (!data) continue;
      if (data === DONE) {
        done = true;
        continue;
      }
      if (done) dataAfterDone = true;
      payloads.push(JSON.parse(data));
    }
  } catch {
    return undefined;
  }
  return { stream, payloads, dataAfterDone };
}
