// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { expect } from "vitest";

/** Probe credentials: an arbitrary key, one with URL-reserved characters, and an nvapi- key. */
export const ECHO_KEYS = [
  ["an arbitrary key", "Zq9xTr4LmPw2Vb7NcK3sHd8YfJ6gUa1E"],
  ["a key with /, +, and =", "Zq9x/Tr4L+mPw2Vb7NcK3s/Hd8YfJ6gUa1E=="],
  // Assembled so no complete key literal sits in the source.
  [
    "an nvapi-shaped key",
    ["nvapi", "Ab3dEk7QxkP2mW9sLt4Rv8Ny1Hc6Zj0Fg5Du3Ke7Ba2Xo9Qi4Ml8S"].join("-"),
  ],
] as const;

export interface EchoShape {
  /** Provider wording around a partial echo of the key. */
  readonly message: (key: string) => string;
  /** Provider wording that must survive redaction, proving the message was quoted. */
  readonly kept: string;
}

/** The partial echoes the round-2 review reproduced on both live paths. */
export const ECHO_SHAPES: Readonly<Record<string, EchoShape>> = {
  "a trailing truncated echo": {
    message: (key) => `bad key ${key.slice(0, 16)}`,
    kept: "bad key [REDACTED]",
  },
  "a truncated echo inside the message": {
    message: (key) => `Invalid key '${key.slice(0, 16)}...' was provided.`,
    kept: "' was provided.",
  },
  "a masked prefix and suffix": {
    message: (key) => `key ${key.slice(0, 8)}****${key.slice(-6)} is not valid`,
    kept: "[REDACTED]****[REDACTED] is not valid",
  },
  "a URL-encoded echo": {
    message: (key) => `rejected key=${encodeURIComponent(key)} for this route`,
    kept: "rejected key=[REDACTED] for this route",
  },
  "a lowercase URL-encoded echo": {
    message: (key) =>
      `rejected key=${encodeURIComponent(key).replace(/%[0-9A-F]{2}/gu, (hex) => hex.toLowerCase())} for this route`,
    kept: "rejected key=[REDACTED] for this route",
  },
  "a zero-width split echo": {
    message: (key) => `bad key ${key.slice(0, 16)}​${key.slice(16)} denied`,
    kept: "bad key [REDACTED] denied",
  },
  "a key interleaved with zero-width spaces": {
    // Every piece is shorter than the minimum, so only matching across them catches it.
    message: (key) => `bad key ${(key.match(/.{1,4}/gu) ?? []).join("\u200B")} denied`,
    kept: "bad key [REDACTED] denied",
  },
  "a newline split echo": {
    message: (key) => `bad key ${key.slice(0, 12)}\n${key.slice(12)} denied`,
    kept: "bad key [REDACTED] denied",
  },
};

/** How the fake endpoint carries the echo. */
export const ECHO_TRANSPORTS = [
  "refused as JSON",
  "refused as plain text",
  "refused only when streamed",
  "in-stream error event",
] as const;

export type EchoTransport = (typeof ECHO_TRANSPORTS)[number];

interface Reply {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
}

const COMPLETION: Reply = {
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({
    choices: [
      { index: 0, message: { role: "assistant", content: "Hello." }, finish_reason: "stop" },
    ],
  }),
};

function echoReply(transport: EchoTransport, message: string, streamed: boolean): Reply {
  const error = { message, type: "invalid_request_error" };
  switch (transport) {
    case "refused as JSON":
      return { status: 401, contentType: "application/json", body: JSON.stringify({ error }) };
    case "refused as plain text":
      return { status: 401, contentType: "text/plain", body: message };
    case "refused only when streamed":
      return streamed
        ? { status: 401, contentType: "application/json", body: JSON.stringify({ error }) }
        : COMPLETION;
    case "in-stream error event":
      return streamed
        ? {
            status: 200,
            contentType: "text/event-stream",
            body: `data: ${JSON.stringify({ error: { ...error, code: 400 } })}\n\n`,
          }
        : COMPLETION;
  }
}

/** A loopback chat-completions endpoint that echoes part of the key it is sent. */
export interface EchoServer {
  readonly baseUrl: string;
  serve(transport: EchoTransport, message: string): void;
  close(): Promise<void>;
}

export async function startEchoServer(): Promise<EchoServer> {
  let current: { transport: EchoTransport; message: string } | undefined;
  const server: Server = createServer((request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      raw += chunk;
    });
    request.on("end", () => {
      const streamed = (JSON.parse(raw) as { stream?: unknown }).stream === true;
      const reply = current
        ? echoReply(current.transport, current.message, streamed)
        : { status: 500, contentType: "text/plain", body: "no reply configured" };
      response.writeHead(reply.status, { "content-type": reply.contentType });
      response.end(reply.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    serve(transport, message) {
      current = { transport, message };
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const INVISIBLE = /[\p{Cc}\p{Cf}\p{Z}]/gu;

function stringsOf(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsOf);
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, entry]) => [key, ...stringsOf(entry)]);
  }
  return [];
}

/**
 * Assert that no run of `minChars` characters of the key, raw or URL-encoded,
 * appears in any output, with invisible characters removed first so a split
 * run still counts. JSON outputs are also checked string by string after
 * parsing, which undoes their escapes.
 */
export function expectNoCredentialRun(
  outputs: readonly string[],
  key: string,
  minChars: number,
  json: readonly string[] = [],
): void {
  const texts = [...outputs, ...json, ...json.flatMap((text) => stringsOf(JSON.parse(text)))].map(
    (text) => text.replace(INVISIBLE, ""),
  );
  for (const form of new Set([key, encodeURIComponent(key)])) {
    for (let index = 0; index + minChars <= form.length; index += 1) {
      const run = form.slice(index, index + minChars);
      for (const text of texts) expect(text).not.toContain(run);
    }
  }
}
