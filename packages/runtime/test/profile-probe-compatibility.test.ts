// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { handleProfileCommand } from "../src/cli/commands/profile.js";
import {
  formatProfileProbeObservation,
  runProfileProbe,
  serializeProfileProbeObservation,
} from "../src/cli/profile-probe.js";
import { limit } from "../src/config/limits.js";
import {
  OUTBOUND_PROXY_AUTH_REQUIRED_CODE,
  OUTBOUND_PROXY_DENIED_CODE,
  OUTBOUND_PROXY_INVALID_CODE,
  OUTBOUND_PROXY_NOT_ENABLED_CODE,
  OUTBOUND_PROXY_UNREACHABLE_CODE,
  OutboundProxyRefusal,
  resetOutboundProxyStateForTests,
  type OutboundProxyRefusalKind,
} from "../src/model/outbound-http-policy.js";
import { SITUATION_CATALOG } from "../src/operator/situation-catalog.js";
import {
  ECHO_KEYS,
  ECHO_SHAPES,
  ECHO_TRANSPORTS,
  expectNoCredentialRun,
  startEchoServer,
  type EchoServer,
} from "./helpers/credential-echo.js";
import { fixtureFetch, loadEndpointFixture } from "./helpers/endpoint-compatibility-fixtures.js";
import { EXECUTABLE_ROUTE_BASE_URLS } from "../src/config/executable-route-urls.js";
import {
  COMPATIBILITY_TOOL_NAME,
  DEFAULT_PROMPTS,
  type probeCompatibility,
} from "../src/profile/probe-core.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("profile probe --live against a provider that echoes part of the key", () => {
  let server: EchoServer;
  beforeAll(async () => {
    server = await startEchoServer();
  });
  afterAll(async () => {
    await server.close();
  });

  /** Run the shipped command, sending its requests to the loopback endpoint. */
  async function probeCommand(key: string, json: boolean): Promise<string> {
    const send = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
      send(`${server.baseUrl}${new URL(String(input)).pathname.replace(/^\/v1/u, "")}`, init),
    );
    vi.stubEnv("DOCSFAB_NVIDIA_API_KEY", key);
    const printed: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      printed.push(String(line));
    });
    await handleProfileCommand([
      "probe",
      "--route",
      "nvidia-api-catalog",
      "--model",
      "nvidia/nemotron-3-ultra-550b-a55b",
      "--live",
      ...(json ? ["--json"] : []),
    ]);
    vi.restoreAllMocks();
    return printed.join("\n");
  }

  const cases = ECHO_KEYS.flatMap(([keyLabel, key]) =>
    Object.entries(ECHO_SHAPES).flatMap(([shapeLabel, shape]) =>
      ECHO_TRANSPORTS.map((transport) => [keyLabel, shapeLabel, transport, key, shape] as const),
    ),
  );

  it.each(cases)(
    "never prints %s from %s (%s)",
    async (_keyLabel, _shapeLabel, transport, key, shape) => {
      server.serve(transport, shape.message(key));
      const text = await probeCommand(key, false);
      const json = await probeCommand(key, true);
      expect(text).toContain('Provider said: "');
      const observation = JSON.parse(json) as {
        compatibility: { checks: { status: string; providerMessage?: string }[] };
      };
      const quoted = observation.compatibility.checks.find((check) => check.status === "fail");
      expect(quoted?.providerMessage).toContain(shape.kept);
      expectNoCredentialRun([text], key, limit("endpointProbe.credentialEchoMinChars").value, [
        json,
      ]);
    },
  );
});

describe("profile probe endpoint compatibility", () => {
  it("bounds every probe response through the provider boundary", async () => {
    const cap = limit("compositionExecution.maxResponseBytes").value;
    const redirects: (RequestRedirect | undefined)[] = [];
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      redirects.push(init?.redirect);
      return new Response("x".repeat(cap + 1), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const observation = await runProfileProbe(
      {
        routeId: "nvidia-api-catalog",
        modelId: "nvidia/nemotron-3-ultra-550b-a55b",
        live: true,
        json: true,
      },
      { environment: { DOCSFAB_NVIDIA_API_KEY: "secret-must-not-appear" } },
    );
    expect(redirects.length).toBeGreaterThan(0);
    expect(redirects.every((redirect) => redirect === "manual")).toBe(true);
    expect(observation.compatibility?.checks[0]).toMatchObject({
      finding: "response-too-large",
      cause: "operational-limit-reached",
    });
    expect(observation.compatibility?.checks[0]?.nextAction).toContain(
      "a host override can only lower that bound",
    );
  });

  it.each([
    ["an arbitrary key", "Zq9xTr4LmPw2Vb7NcK3sHd8YfJ6gUa1E"],
    ["an nvapi-shaped key", `nvapi-Ab3dE${"k".repeat(56)}`],
  ])("never prints %s that a 2xx non-JSON reply echoes", async (_label, key) => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(`${key} echoed back by a misconfigured gateway`, {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
    );
    const observation = await runProfileProbe(
      {
        routeId: "nvidia-api-catalog",
        modelId: "nvidia/nemotron-3-ultra-550b-a55b",
        live: true,
        json: true,
      },
      { environment: { DOCSFAB_NVIDIA_API_KEY: key } },
    );
    expect(observation.verdict).toBe("unreachable");
    const text = formatProfileProbeObservation(observation);
    expect(text).toContain('Provider said: "The reply was not valid JSON (');
    for (const output of [text, serializeProfileProbeObservation(observation)]) {
      expect(output).not.toContain(key.slice(0, 6));
      expect(output).not.toContain(key.slice(6, 12));
    }
  });

  it("surfaces a retired model's end-of-life notice through the live probe stack", async () => {
    const replay = fixtureFetch(loadEndpointFixture("nano-end-of-life-410"));
    vi.stubGlobal("fetch", replay.fetch);
    const observation = await runProfileProbe(
      {
        routeId: "nvidia-api-catalog",
        modelId: "nvidia/nemotron-3-nano-30b-a3b",
        live: true,
        json: true,
      },
      { environment: { DOCSFAB_NVIDIA_API_KEY: "secret-must-not-appear" } },
    );
    expect(observation.verdict).toBe("unreachable");
    expect(observation.compatibility?.verdict).toBe("incompatible");
    expect(observation.compatibility?.checks[0]).toMatchObject({
      finding: "end-of-life",
      owner: "operator-configuration",
      cause: "provider-model-retired",
      httpStatus: 410,
    });
    // One reasoning sample; the terminal refusal stopped further spend.
    expect(replay.requests.map((request) => request.body.stream)).toEqual([undefined]);
    const text = formatProfileProbeObservation(observation);
    expect(text).toContain("availability: fail (end-of-life)");
    expect(text).toContain("has reached its end of life on 2026-09-01T09:00:00Z");
    expect(text).toContain("Next action: Select a model the provider still serves");
    expect(text).not.toContain("no body");
    expect(serializeProfileProbeObservation(observation)).not.toContain("secret-must-not-appear");
  });
});

describe("profile probe --live names a proxy refusal instead of an unreachable route", () => {
  const PROXY_VARIABLES = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
  ] as const;
  const ROUTE = "nvidia-api-catalog";
  const MODEL = "nvidia/nemotron-3-ultra-550b-a55b";

  afterEach(() => {
    resetOutboundProxyStateForTests();
  });

  /** Only `value` applies; every other proxy variable of the worker is cleared. */
  function proxySetting(value: string | undefined): void {
    for (const name of PROXY_VARIABLES) vi.stubEnv(name, undefined);
    if (value !== undefined) vi.stubEnv("HTTPS_PROXY", value);
    resetOutboundProxyStateForTests();
  }

  /**
   * Global fetch answers each probe request in order; a request past the
   * script, or to any other URL, fails the case instead of leaving the host.
   */
  function scriptedRoute(replies: ReadonlyArray<() => Response>) {
    const expected = `${ROUTE_BASE_URL}/chat/completions`;
    const send = vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== expected) throw new Error(`unexpected request to ${url}`);
      const reply = replies[send.mock.calls.length - 1];
      if (!reply) throw new Error("the probe sent more requests than the case scripted");
      return reply();
    });
    vi.stubGlobal("fetch", send);
    return send;
  }

  function probe(probeCompatibility = refuseCompatibility) {
    return runProfileProbe(
      { routeId: ROUTE, modelId: MODEL, live: true, json: true },
      {
        environment: { DOCSFAB_NVIDIA_API_KEY: "secret-must-not-appear" },
        probeCompatibility,
      },
    );
  }

  async function refusalOf(promise: Promise<unknown>): Promise<OutboundProxyRefusal> {
    const error = await promise.then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(OutboundProxyRefusal);
    return error as OutboundProxyRefusal;
  }

  function operatorNextAction(code: string): string | undefined {
    return SITUATION_CATALOG.find((row) => row.id === code && row.family === "operator")
      ?.nextAction;
  }

  it.each([
    ["socks5://h:1", OUTBOUND_PROXY_INVALID_CODE],
    // A valid proxy URL while this worker has not turned proxy support on.
    ["http://proxy.example.test:3128", OUTBOUND_PROXY_NOT_ENABLED_CODE],
  ] as const)(
    "HTTPS_PROXY=%s is refused by the shipped fetch chain before any request",
    async (value, code) => {
      proxySetting(value);
      const trap = scriptedRoute([]);
      const refusal = await refusalOf(probe());
      expect(refusal.code).toBe(code);
      expect(refusal.nextAction).toBe(operatorNextAction(code));
      expect(trap).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["unreachable", OUTBOUND_PROXY_UNREACHABLE_CODE],
    ["denied", OUTBOUND_PROXY_DENIED_CODE],
    ["auth-required", OUTBOUND_PROXY_AUTH_REQUIRED_CODE],
  ] as const)("a %s proxy on the first sample is thrown with its code", async (kind, code) => {
    proxySetting(undefined);
    const send = scriptedRoute([refused(kind), refused(kind)]);
    const refusal = await refusalOf(probe());
    expect(refusal.code).toBe(code);
    expect(refusal.nextAction).toBe(operatorNextAction(code));
    expect(send).toHaveBeenCalled();
  });

  it("a refusal on one prompt throws even when a later prompt answered", async () => {
    proxySetting(undefined);
    const send = scriptedRoute([refused("unreachable"), answered("Plain content.")]);
    const refusal = await refusalOf(probe());
    expect(refusal.code).toBe(OUTBOUND_PROXY_UNREACHABLE_CODE);
    // Every prompt ran: the second sample was reachable, so only the capture throws.
    expect(send).toHaveBeenCalledTimes(DEFAULT_PROMPTS.length);
  });

  it("a refusal before a reachable split throws before the thinking-disabled pass", async () => {
    proxySetting(undefined);
    const send = scriptedRoute([refused("auth-required"), split]);
    const refusal = await refusalOf(probe());
    expect(refusal.code).toBe(OUTBOUND_PROXY_AUTH_REQUIRED_CODE);
    // The split would start the thinking-disabled pass; the refusal stops it first.
    expect(send).toHaveBeenCalledTimes(DEFAULT_PROMPTS.length);
  });

  it("a refusal on the thinking-disabled pass throws even when its other prompt answered", async () => {
    proxySetting(undefined);
    const send = scriptedRoute([
      ...DEFAULT_PROMPTS.map(() => split),
      refused("denied"),
      ...DEFAULT_PROMPTS.slice(1).map(() => answered("Content restored.")),
    ]);
    const refusal = await refusalOf(probe());
    expect(refusal.code).toBe(OUTBOUND_PROXY_DENIED_CODE);
    // Both passes ran in full; the reachable thinking-disabled pass did not hide the refusal.
    expect(send).toHaveBeenCalledTimes(DEFAULT_PROMPTS.length * 2);
  });

  it("adjacent: a non-proxy transport failure still reads as unreachable", async () => {
    proxySetting(undefined);
    scriptedRoute(
      DEFAULT_PROMPTS.map(() => () => {
        throw new TypeError("fetch failed");
      }),
    );
    const observation = await probe();
    expect(observation.verdict).toBe("unreachable");
    expect(observation.compatibility?.checks[0]).toMatchObject({ id: "availability" });
  });

  it("positive control: a first-sample 404 still reads as unreachable", async () => {
    proxySetting(undefined);
    scriptedRoute([
      () =>
        new Response('{"error":{"message":"model not found"}}', {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
    ]);
    const observation = await probe();
    expect(observation.verdict).toBe("unreachable");
    expect(observation.compatibility?.checks[0]).toMatchObject({
      id: "availability",
      finding: "model-not-found",
    });
  });

  it("positive control: a healthy route is probed and measured", async () => {
    proxySetting(undefined);
    scriptedRoute(DEFAULT_PROMPTS.map(() => answered("Plain content.")));
    let measured = false;
    const observation = await probe(async (...args) => {
      measured = true;
      return passingCompatibility(...args);
    });
    expect(observation.verdict).toBe("harness-compatible");
    expect(measured).toBe(true);
  });
});

const ROUTE_BASE_URL = EXECUTABLE_ROUTE_BASE_URLS["nvidia-api-catalog"];

/** A compatibility probe a refused or unreachable route must never reach. */
const refuseCompatibility: typeof probeCompatibility = async () => {
  throw new Error("a refused route must not spend on compatibility requests.");
};

function refused(kind: OutboundProxyRefusalKind): () => Response {
  return () => {
    throw new OutboundProxyRefusal(
      kind,
      `Scripted proxy refusal (outbound-proxy-${kind}).`,
      "HTTPS_PROXY",
    );
  };
}

function chatReply(message: Record<string, string>): Response {
  return new Response(JSON.stringify({ choices: [{ message }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function answered(content: string): () => Response {
  return () => chatReply({ role: "assistant", content });
}

/** Reasoning returned in `reasoning_content` with empty content. */
const split = () => chatReply({ role: "assistant", content: "", reasoning_content: "Thinking." });

const PASSING_SAMPLE = {
  ok: true,
  status: 200,
  eventStream: true,
  events: 3,
  done: true,
  malformedEvents: 0,
  errorEvent: undefined,
  reasoningPresent: false,
  completionTokens: 20,
} as const;

/** A passing compatibility observation; the HTTP path has its own tests. */
const passingCompatibility: typeof probeCompatibility = async () => ({
  toolCall: {
    ...PASSING_SAMPLE,
    content: "",
    toolCalls: [{ name: COMPATIBILITY_TOOL_NAME, arguments: '{"result":"ok"}' }],
    finishReason: "tool_calls",
  },
  structuredOutput: {
    ...PASSING_SAMPLE,
    content: '{"result":"ok","checks":["tool-calls","structured-output"]}',
    toolCalls: [],
    finishReason: "stop",
  },
});
