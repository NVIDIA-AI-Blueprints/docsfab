// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A recording HTTP CONNECT proxy in front of a local TLS server, for proving
 * where DocsFab's outbound requests go. Fixture host names reach the TLS
 * server only through the proxy; children run with a DNS guard that refuses
 * every other name, so a request that skips the proxy can never leave the
 * machine. Keys are generated per run and removed with the temporary root.
 */
import { execFile, spawn } from "node:child_process";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { createServer as createHttpsServer } from "node:https";
import { connect, createServer as createNetServer, type AddressInfo, type Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  COMPATIBILITY_JSON_PROMPT,
  COMPATIBILITY_TOOL_NAME,
} from "../../src/profile/probe-core.js";
import type { TemporaryRoots } from "../helpers/temp.js";

const execute = promisify(execFile);

export const RUNTIME_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** Names the proxy tunnels to the local TLS server. */
export const FIXTURE_HOSTS = ["api.openai.com", "models.example.test"] as const;

export interface ProxyLogEntry {
  readonly line: string;
  readonly proxyAuthorization: string | undefined;
}

export interface TargetRequest {
  readonly host: string | undefined;
  readonly method: string | undefined;
  readonly url: string | undefined;
}

/**
 * How the proxy answers one CONNECT. `tunnel` is the default: 200, then a
 * tunnel to the TLS target for fixture hosts (502 for any other host).
 */
export type ConnectReply =
  | { readonly kind: "tunnel" }
  /** Answer with this status, a canary realm and body, then close. */
  | { readonly kind: "status"; readonly status: number }
  /** Read the request and never answer. */
  | { readonly kind: "silent" }
  /** Answer 200, then reset the socket before any TLS byte. */
  | { readonly kind: "reset-after-200" }
  /** Answer 200, then act as a sink that never speaks TLS. */
  | { readonly kind: "tls-stall" };

/** Text the proxy puts in a refusal; it must never reach DocsFab's output. */
export const PROXY_REFUSAL_CANARY = "CANARYPROXYTEXT";

export interface ProxyFixture {
  readonly root: string;
  readonly caPath: string;
  readonly dnsGuardPath: string;
  readonly dnsLogPath: string;
  readonly proxyUrl: string;
  readonly proxyPort: number;
  readonly targetPort: number;
  readonly proxyLog: ProxyLogEntry[];
  readonly targetRequests: TargetRequest[];
  /**
   * TCP connections the proxy accepted, counted on accept: the log records
   * only complete request heads, so it cannot see a bare connect.
   */
  proxyConnections(): number;
  /** Proxy-side connections the client ended or reset, counted when the proxy sees it. */
  peerClosures(): number;
  /** `peerClosures()` as each target request arrived, in arrival order. */
  readonly peerClosuresAtTargetRequest: number[];
  /** Answer the next CONNECTs with `next` in order, then every later one with `otherwise`. */
  script(next: readonly ConnectReply[], otherwise?: ConnectReply): void;
}

const DNS_GUARD = `
import dns from "node:dns";
import { appendFileSync } from "node:fs";
const allowed = new Set(["localhost"]);
const log = process.env.DNS_GUARD_LOG;
const refuse = (hostname) => {
  if (log) appendFileSync(log, hostname + "\\n");
  return Object.assign(new Error("getaddrinfo ENOTFOUND " + hostname), {
    code: "ENOTFOUND", errno: -3008, syscall: "getaddrinfo", hostname,
  });
};
const lookup = dns.lookup;
dns.lookup = function (hostname, options, callback) {
  const done = typeof options === "function" ? options : callback;
  if (!allowed.has(hostname)) {
    process.nextTick(() => done(refuse(hostname)));
    return {};
  }
  return lookup.call(this, hostname, options, callback);
};
const lookupPromise = dns.promises.lookup;
dns.promises.lookup = async (hostname, options) => {
  if (!allowed.has(hostname)) throw refuse(hostname);
  return lookupPromise(hostname, options);
};
`;

async function certificate(root: string): Promise<{ certificate: string; key: string }> {
  const configPath = join(root, "openssl.cnf");
  const certificatePath = join(root, "certificate.pem");
  const keyPath = join(root, "private-key.pem");
  await writeFile(
    configPath,
    [
      "[req]",
      "distinguished_name = subject",
      "x509_extensions = extensions",
      "prompt = no",
      "[subject]",
      "CN = docsfab-proxy-fixture",
      "[extensions]",
      "subjectAltName = @alternatives",
      "basicConstraints = critical, CA:true",
      "keyUsage = critical, digitalSignature, keyEncipherment, keyCertSign",
      "[alternatives]",
      ...FIXTURE_HOSTS.map((host, index) => `DNS.${String(index + 1)} = ${host}`),
      `DNS.${String(FIXTURE_HOSTS.length + 1)} = localhost`,
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
    certificatePath,
    "-days",
    "1",
    "-config",
    configPath,
  ]);
  await chmod(keyPath, 0o600);
  return {
    certificate: await readFile(certificatePath, "utf8"),
    key: await readFile(keyPath, "utf8"),
  };
}

/**
 * One SSE chat-completions answer, the shape pi-ai's OpenAI adapter reads. It
 * answers what doctor's live check asks: the probe's tool call and JSON
 * object, and the exact connectivity reply; anything else gets "OK".
 */
function chatCompletion(model: string, request: string): string {
  const chunk = (delta: object, finish: string | null, extra: object = {}) =>
    `data: ${JSON.stringify({
      id: "proxy-fixture",
      object: "chat.completion.chunk",
      created: 1,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...extra,
    })}\n\n`;
  const usage = { usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } };
  const body = JSON.parse(request) as { stream?: boolean; tools?: unknown; messages?: unknown };
  if (body.stream !== true) {
    return JSON.stringify({
      id: "proxy-fixture",
      object: "chat.completion",
      created: 1,
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "OK" },
          finish_reason: "stop",
        },
      ],
      ...usage,
    });
  }
  if (Array.isArray(body.tools)) {
    const call = {
      index: 0,
      id: "call-proxy-fixture",
      type: "function",
      function: { name: COMPATIBILITY_TOOL_NAME, arguments: '{"result":"ok"}' },
    };
    return (
      chunk({ role: "assistant", tool_calls: [call] }, null) +
      chunk({}, "tool_calls", usage) +
      "data: [DONE]\n\n"
    );
  }
  const asked = JSON.stringify(body.messages ?? "");
  const content = asked.includes("DOCSFAB_OK")
    ? "DOCSFAB_OK"
    : asked.includes(JSON.stringify(COMPATIBILITY_JSON_PROMPT).slice(1, -1))
      ? '{"result":"ok","checks":["tool-calls","structured-output"]}'
      : "OK";
  return (
    chunk({ role: "assistant", content }, null) + chunk({}, "stop", usage) + "data: [DONE]\n\n"
  );
}

/**
 * `prefix` names the fixture's temporary root; a suite with its own leak guard
 * passes its own, so concurrent suites never count each other's roots.
 */
export async function startProxyFixture(
  roots: TemporaryRoots,
  closers: Array<() => Promise<void>>,
  prefix = "docsfab-proxy-fixture-",
): Promise<ProxyFixture> {
  const root = await roots.create(prefix);
  const { certificate: cert, key } = await certificate(root);
  const caPath = join(root, "certificate.pem");
  const dnsGuardPath = join(root, "dns-guard.mjs");
  const dnsLogPath = join(root, "dns.log");
  await writeFile(dnsGuardPath, DNS_GUARD);
  await writeFile(dnsLogPath, "");

  const targetRequests: TargetRequest[] = [];
  const peerClosuresAtTargetRequest: number[] = [];
  let peerClosures = 0;
  const target = createHttpsServer({ cert, key }, (request, response) => {
    targetRequests.push({ host: request.headers.host, method: request.method, url: request.url });
    peerClosuresAtTargetRequest.push(peerClosures);
    const body: Buffer[] = [];
    request.on("data", (chunk: Buffer) => body.push(chunk));
    request.on("end", () => {
      if (request.url?.endsWith("/chat/completions")) {
        const requestBody = Buffer.concat(body).toString("utf8");
        const stream = (JSON.parse(requestBody) as { stream?: boolean }).stream === true;
        response.writeHead(200, {
          "content-type": stream ? "text/event-stream" : "application/json",
        });
        response.end(chatCompletion("example/model", requestBody));
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end('{"error":{"message":"not found"}}');
    });
  });
  // Both loopback families, so https://[::1] reaches it too.
  await new Promise<void>((done) => target.listen({ port: 0, host: "::", ipv6Only: false }, done));
  const targetPort = (target.address() as AddressInfo).port;

  const proxyLog: ProxyLogEntry[] = [];
  const sockets = new Set<Socket>();
  let connections = 0;
  let queued: ConnectReply[] = [];
  let otherwise: ConnectReply = { kind: "tunnel" };
  const proxy = createNetServer((socket) => {
    let head = Buffer.alloc(0);
    socket.on("error", () => undefined);
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) return;
      socket.off("data", onData);
      const lines = head.subarray(0, end).toString("latin1").split("\r\n");
      const header = lines
        .slice(1)
        .find((line) => line.toLowerCase().startsWith("proxy-authorization:"));
      const line = lines[0] ?? "";
      proxyLog.push({ line, proxyAuthorization: header?.slice(header.indexOf(":") + 1).trim() });
      const reply = queued.shift() ?? otherwise;
      if (reply.kind === "status") {
        const body = `${PROXY_REFUSAL_CANARY} ${String(reply.status)}`;
        socket.end(
          `HTTP/1.1 ${String(reply.status)} Refused\r\n` +
            `proxy-authenticate: Basic realm="${PROXY_REFUSAL_CANARY}"\r\n` +
            `content-length: ${String(body.length)}\r\nconnection: close\r\n\r\n${body}`,
        );
        return;
      }
      if (reply.kind === "silent") {
        socket.on("data", () => undefined);
        return;
      }
      if (reply.kind === "reset-after-200") {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n", () => socket.resetAndDestroy());
        return;
      }
      if (reply.kind === "tls-stall") {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        socket.on("data", () => undefined);
        return;
      }
      const connectTarget = /^CONNECT ([^\s:]+):443 /u.exec(line)?.[1];
      if (!connectTarget || !(FIXTURE_HOSTS as readonly string[]).includes(connectTarget)) {
        socket.end("HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
        return;
      }
      const upstream = connect(targetPort, "127.0.0.1", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        const rest = head.subarray(end + 4);
        if (rest.length > 0) upstream.write(rest);
        socket.pipe(upstream).pipe(socket);
      });
      upstream.on("error", () => socket.destroy());
    };
    socket.on("data", onData);
  });
  proxy.on("connection", (socket: Socket) => {
    connections += 1;
    sockets.add(socket);
    // A FIN or a reset from the client. The proxy's own `destroy()` emits
    // neither event, so the closer below is never counted.
    let peerClosed = false;
    const onPeerClose = () => {
      if (peerClosed) return;
      peerClosed = true;
      peerClosures += 1;
    };
    socket.on("end", onPeerClose);
    socket.on("error", onPeerClose);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((done) => proxy.listen(0, "127.0.0.1", done));
  const proxyPort = (proxy.address() as AddressInfo).port;

  closers.push(async () => {
    // Silent and stalled replies hold their sockets open; close cannot finish until they go.
    for (const socket of sockets) socket.destroy();
    target.closeAllConnections();
    await Promise.all([
      new Promise<void>((done) => target.close(() => done())),
      new Promise<void>((done) => proxy.close(() => done())),
    ]);
  });
  return {
    root,
    caPath,
    dnsGuardPath,
    dnsLogPath,
    proxyUrl: `http://127.0.0.1:${String(proxyPort)}`,
    proxyPort,
    targetPort,
    proxyLog,
    targetRequests,
    proxyConnections: () => connections,
    peerClosures: () => peerClosures,
    peerClosuresAtTargetRequest,
    script(next, fallback = { kind: "tunnel" }) {
      queued = [...next];
      otherwise = fallback;
    },
  };
}

/**
 * A child environment built from nothing, so no proxy variable, NODE_OPTIONS,
 * or provider credential from the test process can reach it.
 */
export function childEnvironment(
  fixture: ProxyFixture,
  extra: Record<string, string>,
): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: fixture.root,
    TMPDIR: fixture.root,
    NO_COLOR: "1",
    NODE_EXTRA_CA_CERTS: fixture.caPath,
    DNS_GUARD_LOG: fixture.dnsLogPath,
    ...extra,
  };
}

export interface ChildResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run a child with the DNS guard preloaded; `deadlineMs` stops a hung child. */
export function runGuardedNode(
  fixture: ProxyFixture,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  deadlineMs: number,
  command: string = process.execPath,
): Promise<ChildResult> {
  return new Promise((done, fail) => {
    const child = spawn(command, ["--import", fixture.dnsGuardPath, ...args], {
      cwd: RUNTIME_ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: deadlineMs,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", fail);
    child.on("close", (code) => done({ code, stdout, stderr }));
  });
}
