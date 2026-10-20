// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readdir, writeFile } from "node:fs/promises";
import { connect, createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { resolveOperatorExecutionBinding } from "../src/model/operator-execution-binding.js";
import {
  OUTBOUND_PROXY_AUTH_REQUIRED_CODE,
  OUTBOUND_PROXY_AUTH_REQUIRED_NEXT_ACTION,
  OUTBOUND_PROXY_DENIED_CODE,
  OUTBOUND_PROXY_DENIED_NEXT_ACTION,
  OUTBOUND_PROXY_INVALID_CODE,
  OUTBOUND_PROXY_INVALID_NEXT_ACTION,
  OUTBOUND_PROXY_NOT_ENABLED_CODE,
  OUTBOUND_PROXY_NOT_ENABLED_NEXT_ACTION,
  OUTBOUND_PROXY_UNREACHABLE_CODE,
  OUTBOUND_PROXY_UNREACHABLE_NEXT_ACTION,
  OutboundProxyRefusal,
  type OutboundProxyRefusalKind,
} from "../src/model/outbound-http-policy.js";
import { classifyProxyFailure } from "../src/model/outbound-proxy-classifier.js";
import { createProviderConnectionFactory, TurnGovernanceError } from "../src/model/provider.js";
import { DOCSFAB_SYSTEM_PROMPT } from "../src/model/request-policy.js";
import { DEFAULT_NEXT_ACTIONS, toOperatorErrorEnvelope } from "../src/operator/error-envelope.js";
import { validModelConfig } from "./helpers.js";
import { temporaryRoots } from "./helpers/temp.js";
import { nestedDeadlineMs, testTimeoutMs } from "./helpers/test-timeouts.js";
import {
  childEnvironment,
  RUNTIME_ROOT,
  runGuardedNode,
  startProxyFixture,
  PROXY_REFUSAL_CANARY,
  type ConnectReply,
  type ProxyFixture,
} from "./support/outbound-proxy-fixture.js";

// Local budgets in ms for one tsx-compiled child that runs every network case
// in sequence; the TLS-stall case alone waits out Node's connect timeout.
const localCaseMs = 120_000;
const localProcessMs = 90_000;
const processDeadline = () => nestedDeadlineMs(localProcessMs, localCaseMs);

const roots = temporaryRoots();
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

const OWN_PREFIXES = ["docsfab-proxy-classify-"];
async function ownTemporaryEntries(): Promise<string[]> {
  return (await readdir(tmpdir())).filter((name) =>
    OWN_PREFIXES.some((prefix) => name.startsWith(prefix)),
  );
}
let entriesBefore: Set<string>;
beforeAll(async () => {
  entriesBefore = new Set(await ownTemporaryEntries());
});
afterAll(async () => {
  const leaked = (await ownTemporaryEntries()).filter((name) => !entriesBefore.has(name));
  expect(leaked).toEqual([]);
});

/** A loopback port with nothing listening: bound once, then released. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

const source = (path: string) => JSON.stringify(pathToFileURL(join(RUNTIME_ROOT, path)).href);

/**
 * Runs every case in one child under the fixture's DNS guard. Errors are
 * captured from real fetches and described as plain data, because an Error
 * cannot cross the process boundary.
 */
const CHILD = `
import { createRequire } from "node:module";
const nodeFetch = globalThis.fetch;
const cases = JSON.parse(process.env.PROXY_CASES);
const PROXY_NAMES = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NO_PROXY", "no_proxy"];

function chainOf(error) {
  const chain = [];
  const seen = new Set();
  for (let item = error; item && typeof item === "object" && !seen.has(item); item = item.cause) {
    seen.add(item);
    chain.push({ ctor: item.constructor?.name, name: item.name, code: item.code ?? null, message: item.message });
  }
  return chain;
}
function outcomeOf(error) {
  return {
    name: error?.name ?? null,
    code: typeof error?.code === "string" ? error.code : null,
    kind: error?.kind ?? null,
    message: String(error?.message),
    nextAction: error?.nextAction ?? null,
    hasCause: error?.cause !== undefined,
    causeCodes: chainOf(error).map((item) => item.code),
  };
}
async function capture(promise) {
  try {
    const response = await promise;
    return { status: response.status ?? null };
  } catch (error) {
    return { error };
  }
}
const results = {};

// Captured before the agent library loads, with Node's own dispatcher and no proxy.
const direct = {};
for (const item of cases.filter((entry) => entry.phase === "direct")) {
  direct[item.id] = (await capture(nodeFetch(item.url))).error;
}

await import(${source("src/model/provider.ts")});
const policy = await import(${source("src/model/outbound-http-policy.ts")});
const { classifyProxyFailure } = await import(${source("src/model/outbound-proxy-classifier.ts")});
const { discoverOpenaiApiModelCatalog } = await import(${source("src/model/openai-api-catalog.ts")});
const piUndici = createRequire(${source("node_modules/@earendil-works/pi-coding-agent/package.json")})("undici");

for (const item of cases) {
  if (item.phase === "direct") {
    const error = direct[item.id];
    results[item.id] = {
      error: outcomeOf(error),
      classified: item.classifyAgainst.map((proxy) => classifyProxyFailure(error, new URL(proxy)) ?? null),
    };
    continue;
  }
  for (const name of PROXY_NAMES) delete process.env[name];
  Object.assign(process.env, item.env);
  policy.resetOutboundProxyStateForTests();
  policy.ensureBuiltInProxy();
  if (item.via === "pi-proxy-agent") {
    // Undici's own proxy agent with a short headers timeout: the same error a
    // never-answered CONNECT ends in, without waiting out Node's default.
    const dispatcher = new piUndici.ProxyAgent({
      uri: item.env.HTTPS_PROXY,
      clientFactory: (origin, options) => new piUndici.Pool(origin, { ...options, headersTimeout: item.headersTimeoutMs }),
    });
    const { error } = await capture(piUndici.fetch(item.url, { dispatcher }));
    results[item.id] = {
      error: outcomeOf(error),
      classified: [classifyProxyFailure(error, new URL(item.env.HTTPS_PROXY)) ?? null],
    };
    await dispatcher.close();
    continue;
  }
  if (item.via === "catalog") {
    const config = JSON.parse(process.env.CATALOG_CONFIG);
    const { error } = await capture(discoverOpenaiApiModelCatalog({ config, purpose: "policy" }));
    results[item.id] = { error: error ? outcomeOf(error) : null };
    continue;
  }
  const seen = {};
  const fetch = policy.outboundFetch({
    onProxiedFailure(error) {
      const dispatcher = globalThis[Symbol.for("undici.globalDispatcher.1")];
      seen.chain = chainOf(error);
      seen.dispatcher = dispatcher?.constructor?.name ?? null;
      seen.piDispatcher = dispatcher instanceof piUndici.Dispatcher;
      // Control: the same check does recognize a dispatcher the library made.
      const own = new piUndici.Agent();
      seen.piControl = own instanceof piUndici.Dispatcher;
      void own.close();
      seen.nodeFetch = globalThis.fetch === nodeFetch;
    },
  });
  const controller = new AbortController();
  const signal = item.abort === "timeout" ? AbortSignal.timeout(item.abortAfterMs) : controller.signal;
  const timer = item.abort === "caller" ? setTimeout(() => controller.abort(), item.abortAfterMs) : undefined;
  const { status, error } = await capture(fetch(item.url, { signal }));
  clearTimeout(timer);
  results[item.id] = { status: status ?? null, error: error ? outcomeOf(error) : null, seen };
}
// Sockets of the aborted CONNECTs stay open until the proxy closes them; do
// not wait for them.
process.stdout.write(JSON.stringify(results), () => process.exit(0));
`;

interface Outcome {
  readonly name: string | null;
  readonly code: string | null;
  readonly kind: string | null;
  readonly message: string;
  readonly nextAction: string | null;
  readonly hasCause: boolean;
  readonly causeCodes: Array<string | number | null>;
}

interface CaseResult {
  readonly status?: number | null;
  readonly error: Outcome | null;
  readonly classified?: Array<{ kind: string; observed: string } | null>;
  readonly seen?: {
    chain?: Array<{
      ctor: string;
      name: string;
      code: string | number | null;
      message: string;
    }>;
    dispatcher?: string | null;
    piDispatcher?: boolean;
    piControl?: boolean;
    nodeFetch?: boolean;
  };
}

interface ChildCase {
  readonly id: string;
  readonly phase?: "direct";
  readonly url: string;
  readonly env?: Record<string, string>;
  readonly via?: "catalog" | "pi-proxy-agent";
  readonly classifyAgainst?: readonly string[];
  readonly abort?: "caller" | "timeout";
  readonly abortAfterMs?: number;
  readonly headersTimeoutMs?: number;
}

const TARGET = "https://models.example.test/v1/models";
/** The proxy password; `%40` makes its decoded form differ from the raw one. */
const CANARY = "CANARY%40PW";
const CANARY_FORMS = [
  CANARY,
  decodeURIComponent(CANARY),
  Buffer.from(`user:${decodeURIComponent(CANARY)}`).toString("base64"),
  Buffer.from(`user:${CANARY}`).toString("base64"),
];
// Execution plumbing, not product bounds: when a caller aborts a CONNECT the
// proxy never answers, and how long undici waits for that answer in the
// headers-timeout case.
const ABORT_AFTER_MS = 300;
const SHORT_HEADERS_TIMEOUT_MS = 300;

async function runChild(
  fixture: ProxyFixture,
  cases: readonly ChildCase[],
  replies: readonly ConnectReply[],
): Promise<Record<string, CaseResult>> {
  fixture.script(replies);
  const directory = await roots.create("docsfab-proxy-classify-");
  const script = join(directory, "child.mts");
  await writeFile(script, CHILD);
  const result = await runGuardedNode(
    fixture,
    ["--import", "tsx", script],
    childEnvironment(fixture, {
      PROXY_CASES: JSON.stringify(cases),
      CATALOG_CONFIG: JSON.stringify({
        ...validModelConfig,
        providerId: "openai",
        baseUrl: "https://api.openai.com/v1",
        modelId: "gpt-5.4",
        apiKey: `sk-${"A".repeat(24)}`,
      }),
    }),
    processDeadline(),
  );
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout) as Record<string, CaseResult>;
}

describe("proxy failures on Node's fetch", { timeout: testTimeoutMs(localCaseMs) }, () => {
  it("pins the tunnel error shape, codes 403/407/unreachable, and leaves every adjacent failure uncoded", async () => {
    const fixture = await startProxyFixture(roots, closers, "docsfab-proxy-classify-fixture-");
    const closed = await closedPort();
    const proxy = fixture.proxyUrl;
    // Every proxy setting carries a password, so a refusal that echoed the
    // setting would show it.
    const withCredential = (address: string) => `http://user:${CANARY}@${address}`;
    const viaProxy = { HTTPS_PROXY: withCredential(`127.0.0.1:${String(fixture.proxyPort)}`) };
    const cases: ChildCase[] = [
      {
        id: "direct-target-enotfound",
        phase: "direct",
        url: TARGET,
        classifyAgainst: ["http://proxy.example.test:3128", proxy],
      },
      {
        id: "direct-refused",
        phase: "direct",
        url: `https://127.0.0.1:${String(closed)}/`,
        classifyAgainst: [proxy, `http://127.0.0.1:${String(closed)}`],
      },
      { id: "tunnel-403", url: TARGET, env: viaProxy },
      { id: "tunnel-407", url: TARGET, env: viaProxy },
      { id: "tunnel-502", url: TARGET, env: viaProxy },
      {
        id: "caller-abort",
        url: TARGET,
        env: viaProxy,
        abort: "caller",
        abortAfterMs: ABORT_AFTER_MS,
      },
      {
        id: "timeout-abort",
        url: TARGET,
        env: viaProxy,
        abort: "timeout",
        abortAfterMs: ABORT_AFTER_MS,
      },
      { id: "reset-after-200", url: TARGET, env: viaProxy },
      { id: "tls-stall", url: TARGET, env: viaProxy },
      { id: "catalog-healthy", url: TARGET, env: viaProxy, via: "catalog" },
      { id: "catalog-502", url: TARGET, env: viaProxy, via: "catalog" },
      { id: "catalog-504", url: TARGET, env: viaProxy, via: "catalog" },
      {
        id: "headers-timeout",
        url: TARGET,
        env: viaProxy,
        via: "pi-proxy-agent",
        headersTimeoutMs: SHORT_HEADERS_TIMEOUT_MS,
      },
      {
        id: "catalog-refused-ip",
        url: TARGET,
        env: { HTTPS_PROXY: withCredential(`127.0.0.1:${String(closed)}`) },
        via: "catalog",
      },
      {
        id: "catalog-refused-localhost",
        url: TARGET,
        env: { HTTPS_PROXY: withCredential(`localhost:${String(closed)}`) },
        via: "catalog",
      },
      {
        id: "catalog-proxy-enotfound",
        url: TARGET,
        env: { HTTPS_PROXY: withCredential("proxy.example.test:3128") },
        via: "catalog",
      },
      {
        // Bypassed by NO_PROXY: the direct connection fails exactly as an
        // unreachable proxy on the same port would, and must stay uncoded.
        id: "bypass-refused",
        url: `https://0.0.0.0:${String(closed)}/`,
        env: {
          HTTPS_PROXY: `http://127.0.0.1:${String(closed)}`,
          NO_PROXY: "0.0.0.0",
        },
      },
    ];
    const results = await runChild(fixture, cases, [
      { kind: "status", status: 403 },
      { kind: "status", status: 407 },
      { kind: "status", status: 502 },
      { kind: "silent" },
      { kind: "silent" },
      { kind: "reset-after-200" },
      { kind: "tls-stall" },
      { kind: "tunnel" },
      { kind: "status", status: 502 },
      { kind: "status", status: 504 },
      { kind: "silent" },
    ]);

    // Row 7: no form of the proxy password and no text the proxy sent reaches
    // any refusal, raw error, or cause chain the child observed.
    const observed = JSON.stringify(results);
    for (const form of [...CANARY_FORMS, PROXY_REFUSAL_CANARY]) {
      expect(observed).not.toContain(form);
    }
    // The password did reach the proxy, so its absence above is a real check.
    expect(fixture.proxyLog[0]?.proxyAuthorization).toBe(`Basic ${CANARY_FORMS[2]!}`);

    // Row 1 pin: Node's own dispatcher and fetch answered, with this exact chain.
    for (const status of [403, 407, 502]) {
      const seen = results[`tunnel-${String(status)}`]!.seen!;
      expect(seen.chain, JSON.stringify(seen)).toEqual([
        {
          ctor: "TypeError",
          name: "TypeError",
          code: null,
          message: "fetch failed",
        },
        {
          ctor: "DOMException",
          name: "Error",
          code: 0,
          message: "Request was cancelled.",
        },
        {
          ctor: "RequestAbortedError",
          name: "AbortError",
          code: "UND_ERR_ABORTED",
          message: `Proxy response (${String(status)}) !== 200 when HTTP Tunneling`,
        },
      ]);
      expect(seen, JSON.stringify(seen)).toMatchObject({
        dispatcher: "EnvHttpProxyAgent",
        piDispatcher: false,
        piControl: true,
        nodeFetch: true,
      });
    }

    const host = "models.example.test";
    expect(results["tunnel-403"]!.error).toMatchObject({
      name: "OutboundProxyRefusal",
      code: OUTBOUND_PROXY_DENIED_CODE,
      kind: "denied",
      nextAction: OUTBOUND_PROXY_DENIED_NEXT_ACTION,
      hasCause: false,
      message: `The HTTPS_PROXY proxy refused to open a tunnel to ${host} with HTTP 403 (outbound-proxy-denied). Nothing was sent to ${host}.`,
    });
    expect(results["tunnel-407"]!.error).toMatchObject({
      name: "OutboundProxyRefusal",
      code: OUTBOUND_PROXY_AUTH_REQUIRED_CODE,
      kind: "auth-required",
      nextAction: OUTBOUND_PROXY_AUTH_REQUIRED_NEXT_ACTION,
      hasCause: false,
      message: `The HTTPS_PROXY proxy asked for proxy authentication with HTTP 407 before opening a tunnel to ${host} (outbound-proxy-auth-required). Nothing was sent to ${host}.`,
    });
    // Every other tunnel reply and every other abort keeps the raw transport error.
    expect(results["tunnel-502"]!.error).toMatchObject({
      name: "TypeError",
      message: "fetch failed",
      causeCodes: [null, 0, "UND_ERR_ABORTED"],
    });
    expect(results["caller-abort"]!.error).toMatchObject({
      name: "AbortError",
      code: null,
    });
    expect(results["timeout-abort"]!.error).toMatchObject({
      name: "TimeoutError",
      code: null,
    });
    expect(results["reset-after-200"]!.error).toMatchObject({
      name: "TypeError",
      causeCodes: [null, "ECONNRESET"],
    });
    expect(results["tls-stall"]!.error).toMatchObject({
      name: "TypeError",
      causeCodes: [null, "UND_ERR_CONNECT_TIMEOUT"],
    });

    // Catalog discovery: a healthy tunnel reaches the target; a 502 or 504
    // from the proxy stays the catalog's own network failure.
    expect(results["catalog-healthy"]!.error).toMatchObject({
      code: "model-absent",
    });
    expect(results["catalog-502"]!.error).toMatchObject({
      code: "network-failure",
    });
    expect(results["catalog-504"]!.error).toMatchObject({
      code: "network-failure",
    });
    for (const [id, observed] of [
      ["catalog-refused-ip", "ECONNREFUSED"],
      ["catalog-refused-localhost", "ECONNREFUSED"],
      ["catalog-proxy-enotfound", "ENOTFOUND"],
    ] as const) {
      expect(results[id]!.error, id).toEqual({
        name: "OutboundProxyRefusal",
        code: OUTBOUND_PROXY_UNREACHABLE_CODE,
        kind: "unreachable",
        nextAction: OUTBOUND_PROXY_UNREACHABLE_NEXT_ACTION,
        hasCause: false,
        causeCodes: [OUTBOUND_PROXY_UNREACHABLE_CODE],
        message: `Could not connect to the HTTPS_PROXY proxy for an outbound HTTPS request: ${observed} (outbound-proxy-unreachable). Nothing was sent to api.openai.com.`,
      });
    }
    expect(results["bypass-refused"]!.error).toMatchObject({
      name: "TypeError",
      causeCodes: [null, "ECONNREFUSED"],
    });

    // Row 3b, errors captured from real fetches: a target lookup failure and a
    // direct connection to another port are never the proxy's; a headers
    // timeout is not coded.
    expect(results["direct-target-enotfound"]!.error.causeCodes).toEqual([null, "ENOTFOUND"]);
    expect(results["direct-target-enotfound"]!.classified).toEqual([null, null]);
    expect(results["direct-refused"]!.classified).toEqual([
      null,
      { kind: "unreachable", observed: "ECONNREFUSED" },
    ]);
    expect(results["headers-timeout"]!.error.causeCodes).toEqual([null, "UND_ERR_HEADERS_TIMEOUT"]);
    expect(results["headers-timeout"]!.classified).toEqual([null]);

    // One CONNECT per proxied request: nothing was replayed or doubled.
    const models = "CONNECT models.example.test:443 HTTP/1.1";
    const openai = "CONNECT api.openai.com:443 HTTP/1.1";
    expect(fixture.proxyLog.map((entry) => entry.line)).toEqual([
      ...Array<string>(7).fill(models),
      ...Array<string>(3).fill(openai),
      models,
    ]);
    expect(fixture.proxyConnections()).toBe(fixture.proxyLog.length);
  });
});

/** The error Node gives a TCP connect to `port` on loopback, captured from a real attempt. */
async function connectError(port: number): Promise<NodeJS.ErrnoException> {
  return new Promise((done) => {
    connect(port, "127.0.0.1").on("error", done);
  });
}

/** The error Node gives a second listen on a port already in use, captured from a real attempt. */
async function listenError(port: number): Promise<NodeJS.ErrnoException> {
  const server = createServer();
  const error = await new Promise<NodeJS.ErrnoException>((done) => {
    server.once("error", done);
    server.listen(port, "127.0.0.1");
  });
  server.close();
  return error;
}

/**
 * The same fields as `error` with only the port changed, for a protocol
 * default port that a test must never dial.
 */
function onPort(error: NodeJS.ErrnoException, port: number): Error {
  const fields = error as NodeJS.ErrnoException & { address?: string; port?: number };
  return Object.assign(
    new Error(error.message.replace(`:${String(fields.port)}`, `:${String(port)}`)),
    {
      errno: fields.errno,
      code: fields.code,
      syscall: fields.syscall,
      address: fields.address,
      port,
    },
  );
}

describe("classifyProxyFailure on captured Node errors", () => {
  it("codes a refused connect to the proxy's own port and nothing else that carries that port", async () => {
    const port = await closedPort();
    const refused = await connectError(port);
    expect(refused).toMatchObject({ code: "ECONNREFUSED", syscall: "connect", port });
    expect(classifyProxyFailure(refused, new URL(`http://127.0.0.1:${String(port)}`))).toEqual({
      kind: "unreachable",
      observed: "ECONNREFUSED",
    });

    // The only other Node errors that carry a port come from bind and listen,
    // with codes no connect produces; one on the proxy's own port stays uncoded.
    const listener = createServer();
    await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
    const busyPort = (listener.address() as AddressInfo).port;
    const inUse = await listenError(busyPort);
    await new Promise<void>((done) => listener.close(() => done()));
    expect(inUse).toMatchObject({ code: "EADDRINUSE", syscall: "listen", port: busyPort });
    expect(classifyProxyFailure(inUse, new URL(`http://127.0.0.1:${String(busyPort)}`))).toBe(
      undefined,
    );
  });

  // URL drops a protocol's default port, so `http://proxy:80` arrives portless.
  it.each([
    ["http://127.0.0.1", 80],
    ["http://127.0.0.1:80", 80],
    ["https://127.0.0.1", 443],
    ["https://127.0.0.1:443", 443],
  ])("codes a refused connect on the default port of %s", async (proxy, port) => {
    expect(new URL(proxy).port).toBe("");
    const refused = onPort(await connectError(await closedPort()), port);
    expect(classifyProxyFailure(refused, new URL(proxy))).toEqual({
      kind: "unreachable",
      observed: "ECONNREFUSED",
    });
  });

  it("does not take the default port for a proxy that names another one", async () => {
    const refused = onPort(await connectError(await closedPort()), 80);
    expect(classifyProxyFailure(refused, new URL("http://127.0.0.1:8080"))).toBe(undefined);
    expect(classifyProxyFailure(refused, new URL("https://127.0.0.1"))).toBe(undefined);
  });
});

describe("refusal kinds", () => {
  const expected: Record<OutboundProxyRefusalKind, [string, string]> = {
    invalid: [OUTBOUND_PROXY_INVALID_CODE, OUTBOUND_PROXY_INVALID_NEXT_ACTION],
    "not-enabled": [OUTBOUND_PROXY_NOT_ENABLED_CODE, OUTBOUND_PROXY_NOT_ENABLED_NEXT_ACTION],
    unreachable: [OUTBOUND_PROXY_UNREACHABLE_CODE, OUTBOUND_PROXY_UNREACHABLE_NEXT_ACTION],
    denied: [OUTBOUND_PROXY_DENIED_CODE, OUTBOUND_PROXY_DENIED_NEXT_ACTION],
    "auth-required": [OUTBOUND_PROXY_AUTH_REQUIRED_CODE, OUTBOUND_PROXY_AUTH_REQUIRED_NEXT_ACTION],
  };

  it.each(Object.entries(expected))(
    "%s carries its own code, next action, and catalog row",
    (kind, [code, nextAction]) => {
      const refusal = new OutboundProxyRefusal(kind as OutboundProxyRefusalKind, "refused");
      expect(refusal.code).toBe(code);
      expect(refusal.code).toBe(`outbound-proxy-${kind}`);
      expect(refusal.nextAction).toBe(nextAction);
      expect(DEFAULT_NEXT_ACTIONS[code]).toBe(nextAction);
      expect(toOperatorErrorEnvelope(refusal)).toMatchObject({
        code,
        docsAnchor: "docs/about/security.md",
      });
    },
  );

  // The envelope redacts URL-shaped text; a new next action must survive it.
  it.each(["unreachable", "denied", "auth-required"] as const)(
    "%s reaches the operator envelope with its next action intact",
    (kind) => {
      const refusal = new OutboundProxyRefusal(kind, "refused", "HTTPS_PROXY");
      expect(toOperatorErrorEnvelope(refusal).nextAction).toBe(expected[kind][1]);
    },
  );

  it.each([
    ["unreachable", "infrastructure"],
    ["denied", "operator-input"],
    ["auth-required", "auth"],
  ])("%s is classed as %s in the envelope", (kind, failureClass) => {
    const envelope = toOperatorErrorEnvelope(
      new OutboundProxyRefusal(kind as OutboundProxyRefusalKind, "refused", "HTTPS_PROXY"),
    );
    expect(envelope).toMatchObject({ failure: { class: failureClass } });
  });
});

/** A chat-completions answer the real pi-ai adapter accepts. */
function landedSse(model: string): Response {
  const chunk = (delta: object, finish: string | null, extra: object = {}) =>
    `data: ${JSON.stringify({ id: "landed", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
  return new Response(
    chunk({ role: "assistant", content: "OK" }, null) +
      chunk({}, "stop", {
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      }) +
      "data: [DONE]\n\n",
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

const TURN_CONTEXT = {
  systemPrompt: DOCSFAB_SYSTEM_PROMPT,
  messages: [{ role: "user" as const, content: "Reply OK.", timestamp: 1 }],
  tools: [],
};

/** One governed turn on a real connection whose transport fetch is scripted. */
async function governedTurn(
  respond: (call: number) => Response | never,
  options: { maxProviderTurns?: number } = {},
) {
  const bound = await resolveOperatorExecutionBinding({
    model: validModelConfig,
  });
  let calls = 0;
  const factory = createProviderConnectionFactory({
    routeId: bound.profile.routeId,
    transport: bound.profile.transport,
    fetch: async () => {
      calls += 1;
      return respond(calls);
    },
  });
  const connection = await factory.create(
    { profile: bound.profile, credential: bound.credential },
    {
      evidenceIdentity: { repositoryRevision: "a".repeat(40) },
      // Backoff collapsed: these cases count requests, not seconds.
      providerTurnRetry: { baseDelayMs: 0, maxDelayMs: 0 },
      ...(options.maxProviderTurns === undefined
        ? {}
        : { limits: { maxProviderTurns: options.maxProviderTurns } }),
    },
  );
  const stream = connection.runtime.streamSimple(connection.model, TURN_CONTEXT, undefined);
  const events: Array<{ type: string }> = [];
  for await (const event of stream as AsyncIterable<{ type: string }>) events.push(event);
  return { calls, requests: () => calls, last: events.at(-1)?.type, connection };
}

describe("provider transport and proxy refusals", () => {
  const refusal = (kind: OutboundProxyRefusalKind) =>
    new OutboundProxyRefusal(kind, `refused (outbound-proxy-${kind})`, "HTTPS_PROXY");

  it("replays an unreachable proxy in the turn and lands", async () => {
    const turn = await governedTurn((call) => {
      if (call === 1) throw refusal("unreachable");
      return landedSse(validModelConfig.modelId);
    });
    expect(turn.calls).toBe(2);
    expect(turn.last).toBe("done");
    // The replay that landed reset the slot.
    expect(turn.connection.providerTransport?.lastProxyRefusal()).toBeUndefined();
  });

  it("keeps the unreachable refusal when every replay fails", async () => {
    const turn = await governedTurn(() => {
      throw refusal("unreachable");
    });
    expect(turn.calls).toBeGreaterThan(1);
    expect(turn.last).toBe("error");
    expect(turn.connection.providerTransport?.lastProxyRefusal()?.code).toBe(
      OUTBOUND_PROXY_UNREACHABLE_CODE,
    );
  });

  it.each(["denied", "auth-required"] as const)(
    "never replays %s and exposes it to the caller",
    async (kind) => {
      const turn = await governedTurn(() => {
        throw refusal(kind);
      });
      expect(turn.calls).toBe(1);
      expect(turn.last).toBe("error");
      expect(turn.connection.providerTransport?.lastProxyRefusal()?.code).toBe(
        `outbound-proxy-${kind}`,
      );
    },
  );

  it("replays an unreachable proxy whose replay fails without a proxy error and keeps no refusal", async () => {
    const turn = await governedTurn((call) => {
      if (call === 1) throw refusal("unreachable");
      return new Response("unavailable", { status: 503 });
    });
    expect(turn.calls).toBeGreaterThan(1);
    expect(turn.last).toBe("error");
    // A stale code here would be thrown as the proxy's fault for a 503.
    expect(turn.connection.providerTransport?.lastProxyRefusal()).toBeUndefined();
  });

  it("a turn the governor stops before any request does not report the previous turn's refusal", async () => {
    const turn = await governedTurn(
      () => {
        throw refusal("denied");
      },
      { maxProviderTurns: 1 },
    );
    const transport = turn.connection.providerTransport!;
    const attempts = turn.connection.physicalProviderAttempts!;
    expect(turn.calls).toBe(1);
    expect(transport.lastProxyRefusal()?.code).toBe(OUTBOUND_PROXY_DENIED_CODE);
    const spent = attempts.spent();

    let stopped: unknown;
    try {
      turn.connection.runtime.streamSimple(turn.connection.model, TURN_CONTEXT, undefined);
    } catch (error) {
      stopped = error;
    }
    expect(stopped).toBeInstanceOf(TurnGovernanceError);
    expect((stopped as TurnGovernanceError).turn.reason).toBe("provider-turn-limit");
    expect(transport.lastProxyRefusal()).toBeUndefined();
    expect(turn.requests()).toBe(1);
    expect(attempts.spent()).toBe(spent);
  });

  it("records no proxy refusal for an unrelated transport error", async () => {
    const turn = await governedTurn(() => {
      throw new TypeError("fetch failed");
    });
    expect(turn.calls).toBeGreaterThan(1);
    expect(turn.connection.providerTransport?.lastProxyRefusal()).toBeUndefined();
  });
});
