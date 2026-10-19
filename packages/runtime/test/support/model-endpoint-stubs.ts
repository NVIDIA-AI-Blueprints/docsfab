// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Fake model endpoints for proving where a request goes and what it carries.
 *
 * - `startModelUpstream` answers OpenAI-compatible chat completions, the
 *   Responses API, and Anthropic Messages over plain HTTP on loopback, or over TLS with a per-run
 *   self-signed certificate. It records each request's Host header, path, and
 *   whether a credential header arrived and equalled the configured key, never
 *   a header value, plus the request body fields the tests assert.
 * - `startTlsForwarder` is a minimal TLS forwarder in front of any upstream. It
 *   logs request bodies, never headers, and passes the credential header on
 *   unread, the way an operator's gateway would.
 *
 * Keys are generated per run with openssl and removed with the temporary root.
 */
import { execFile } from "node:child_process";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";

import type { TemporaryRoots } from "../helpers/temp.js";

const execute = promisify(execFile);

/** What a fake upstream keeps of a credential header: never its value. */
export type CredentialSeen = "absent" | "the configured key" | "another value";

export interface UpstreamRequest {
  /** The Host header: the host and port the client addressed. */
  readonly host: string | undefined;
  readonly method: string | undefined;
  readonly path: string | undefined;
  readonly credential: CredentialSeen;
  readonly body: {
    readonly model?: unknown;
    readonly max_tokens?: unknown;
    readonly max_completion_tokens?: unknown;
    readonly max_output_tokens?: unknown;
    readonly reasoning_effort?: unknown;
    readonly reasoning?: unknown;
    readonly thinking?: unknown;
    readonly chat_template_kwargs?: unknown;
    readonly output_config?: unknown;
    readonly stream?: unknown;
  };
}

export interface ModelUpstream {
  /** The base URL to configure, ending in `/v1`. */
  readonly baseUrl: string;
  readonly requests: UpstreamRequest[];
  /** Present for a TLS upstream: the CA file a child trusts with NODE_EXTRA_CA_CERTS. */
  readonly caPath?: string;
}

export interface ModelUpstreamOptions {
  /** The key the upstream compares a credential header with; never recorded. */
  readonly expectedKey: string;
  /** Serve TLS with a per-run certificate for localhost, 127.0.0.1, and ::1. */
  readonly tls?: { readonly roots: TemporaryRoots };
  /** The model name the response carries; defaults to the requested model. */
  readonly servedModel?: string;
  /** `answer` streams a short reply; `refuse` answers 400 so a run stops at once. */
  readonly mode?: "answer" | "refuse";
}

const closers: Array<() => Promise<void>> = [];

/** Close every stub this module started. Call from `afterEach`. */
export async function closeModelEndpointStubs(): Promise<void> {
  await Promise.all(closers.splice(0).map((close) => close()));
}

function credentialSeen(request: IncomingMessage, expectedKey: string): CredentialSeen {
  const authorization = request.headers.authorization;
  const apiKey = request.headers["x-api-key"];
  const value =
    typeof authorization === "string"
      ? authorization.replace(/^Bearer\s+/iu, "")
      : typeof apiKey === "string"
        ? apiKey
        : undefined;
  if (value === undefined) return "absent";
  return value === expectedKey ? "the configured key" : "another value";
}

function bodyFields(text: string): UpstreamRequest["body"] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const record = parsed as Record<string, unknown>;
  const kept: Record<string, unknown> = {};
  for (const key of [
    "model",
    "max_tokens",
    "max_completion_tokens",
    "max_output_tokens",
    "reasoning_effort",
    "reasoning",
    "thinking",
    "chat_template_kwargs",
    "output_config",
    "stream",
  ]) {
    if (Object.hasOwn(record, key)) kept[key] = record[key];
  }
  return kept;
}

function chatCompletionStream(model: string): string {
  const chunk = (delta: object, finish: string | null, extra: object = {}) =>
    `data: ${JSON.stringify({
      id: "settings-stub",
      object: "chat.completion.chunk",
      created: 1,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...extra,
    })}\n\n`;
  return (
    chunk({ role: "assistant", content: "DOCSFAB_OK" }, null) +
    chunk({}, "stop", {
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    }) +
    "data: [DONE]\n\n"
  );
}

function responsesStream(model: string): string {
  const event = (type: string, data: object) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const response = {
    id: "settings-stub",
    object: "response",
    model,
    status: "completed",
  };
  const item = {
    id: "msg-settings-stub",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "DOCSFAB_OK", annotations: [] }],
  };
  return [
    event("response.created", {
      response: { ...response, status: "in_progress", output: [] },
    }),
    event("response.output_item.added", {
      output_index: 0,
      item: { ...item, content: [] },
    }),
    event("response.output_text.delta", {
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: "DOCSFAB_OK",
    }),
    event("response.output_item.done", { output_index: 0, item }),
    event("response.completed", {
      response: {
        ...response,
        output: [item],
        usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
      },
    }),
  ].join("");
}

function anthropicMessagesStream(model: string): string {
  const event = (type: string, data: object) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  return [
    event("message_start", {
      message: {
        id: "msg-settings-stub",
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        usage: { input_tokens: 3, output_tokens: 0 },
      },
    }),
    event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
    event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "DOCSFAB_OK" } }),
    event("content_block_stop", { index: 0 }),
    event("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }),
    event("message_stop", {}),
  ].join("");
}

async function selfSignedCertificate(
  roots: TemporaryRoots,
): Promise<{ cert: string; key: string; caPath: string }> {
  const root = await roots.create("docsfab-model-stub-tls-");
  const configPath = join(root, "openssl.cnf");
  const caPath = join(root, "certificate.pem");
  const keyPath = join(root, "private-key.pem");
  await writeFile(
    configPath,
    [
      "[req]",
      "distinguished_name = subject",
      "x509_extensions = extensions",
      "prompt = no",
      "[subject]",
      "CN = localhost",
      "[extensions]",
      "subjectAltName = @alternatives",
      "basicConstraints = critical, CA:true",
      "keyUsage = critical, digitalSignature, keyEncipherment, keyCertSign",
      "[alternatives]",
      "DNS.1 = localhost",
      "IP.1 = 127.0.0.1",
      "IP.2 = ::1",
      "",
    ].join("\n"),
  );
  await execute("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-sha256",
    "-nodes",
    "-keyout",
    keyPath,
    "-out",
    caPath,
    "-days",
    "1",
    "-config",
    configPath,
  ]);
  await chmod(keyPath, 0o600);
  return {
    cert: await readFile(caPath, "utf8"),
    key: await readFile(keyPath, "utf8"),
    caPath,
  };
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((done) => server.listen({ port: 0, host: "127.0.0.1" }, done));
  closers.push(
    () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  );
  return (server.address() as AddressInfo).port;
}

/** A fake OpenAI-compatible upstream; see the module comment. */
export async function startModelUpstream(options: ModelUpstreamOptions): Promise<ModelUpstream> {
  const requests: UpstreamRequest[] = [];
  const handler = (request: IncomingMessage, response: import("node:http").ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const body = bodyFields(text);
      requests.push({
        host: request.headers.host,
        method: request.method,
        path: request.url,
        credential: credentialSeen(request, options.expectedKey),
        body,
      });
      if (options.mode === "refuse") {
        response.writeHead(400, { "content-type": "application/json" });
        response.end('{"error":{"message":"settings stub: request recorded, no answer"}}');
        return;
      }
      const model =
        options.servedModel ?? (typeof body.model === "string" ? body.model : "stub-model");
      response.writeHead(200, { "content-type": "text/event-stream" });
      const path = (request.url ?? "").split("?")[0]!;
      response.end(
        path.endsWith("/responses")
          ? responsesStream(model)
          : path.endsWith("/messages")
            ? anthropicMessagesStream(model)
            : chatCompletionStream(model),
      );
    });
  };
  if (options.tls) {
    const { cert, key, caPath } = await selfSignedCertificate(options.tls.roots);
    const server = createHttpsServer({ cert, key }, handler);
    const port = await listen(server);
    return {
      baseUrl: `https://localhost:${String(port)}/v1`,
      requests,
      caPath,
    };
  }
  const port = await listen(createHttpServer(handler));
  return { baseUrl: `http://127.0.0.1:${String(port)}/v1`, requests };
}

export interface ForwardedBody {
  readonly path: string | undefined;
  /** The parsed request body. Headers are never logged. */
  readonly body: unknown;
}

export interface TlsForwarder {
  /** The base URL clients configure, ending in `/v1`. */
  readonly baseUrl: string;
  readonly caPath: string;
  readonly bodies: ForwardedBody[];
}

/**
 * A minimal TLS forwarder: every request goes to `upstreamBaseUrl` plus the
 * path after `/v1`, with its headers passed on unread. Only the body is logged.
 */
export async function startTlsForwarder(input: {
  readonly roots: TemporaryRoots;
  readonly upstreamBaseUrl: string;
}): Promise<TlsForwarder> {
  const bodies: ForwardedBody[] = [];
  const { cert, key, caPath } = await selfSignedCertificate(input.roots);
  const upstream = input.upstreamBaseUrl.replace(/\/+$/u, "");
  const server = createHttpsServer({ cert, key }, (request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(body.toString("utf8"));
      } catch {
        parsed = null;
      }
      bodies.push({ path: request.url, body: parsed });
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (value === undefined || ["host", "content-length", "connection"].includes(name))
          continue;
        headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      const path = (request.url ?? "/").replace(/^\/v1/u, "");
      void fetch(`${upstream}${path}`, {
        method: request.method ?? "POST",
        headers,
        body,
      })
        .then(async (answer) => {
          response.writeHead(answer.status, {
            "content-type": answer.headers.get("content-type") ?? "application/json",
          });
          response.end(Buffer.from(await answer.arrayBuffer()));
        })
        .catch(() => {
          response.writeHead(502, { "content-type": "application/json" });
          response.end('{"error":{"message":"forwarder: upstream unreachable"}}');
        });
    });
  });
  const port = await listen(server);
  return { baseUrl: `https://localhost:${String(port)}/v1`, caPath, bodies };
}
