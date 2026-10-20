// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ModelEndpointConfig } from "../src/model/configuration.js";
import {
  createLoopbackHttpsFetch,
  LoopbackResolutionRefusal,
} from "../src/model/loopback-http-fetch.js";
import { discoverNvidiaInferenceModelCatalog } from "../src/model/nvidia-inference-catalog.js";
import { NVIDIA_INFERENCE_CATALOG_ORIGIN } from "../src/model/catalog-serving-route.js";
import { discoverOpenaiApiModelCatalog } from "../src/model/openai-api-catalog.js";
import {
  InferenceHubMetadataError,
  inspectInferenceHubMetadata,
  type InferenceHubMetadataInspection,
} from "../src/model/inference-hub-metadata.js";
import { inspectModelProfile } from "../src/model/profile-inspection.js";
import {
  ensureBuiltInProxy,
  formatOutboundProxy,
  inspectOutboundProxy,
  isBypassedByNoProxy,
  OUTBOUND_PROXY_AUTH_REQUIRED_CODE,
  OUTBOUND_PROXY_DENIED_CODE,
  OUTBOUND_PROXY_INVALID_CODE,
  OUTBOUND_PROXY_INVALID_NEXT_ACTION,
  OUTBOUND_PROXY_NOT_ENABLED_CODE,
  OUTBOUND_PROXY_NOT_ENABLED_NEXT_ACTION,
  OUTBOUND_PROXY_UNREACHABLE_CODE,
  OutboundProxyRefusal,
  outboundFetch,
  proxyEnableDecision,
  resetOutboundProxyStateForTests,
  resolveOutboundProxy,
  type ProxyRuntime,
} from "../src/model/outbound-http-policy.js";
import { createModelConnection, createProviderBoundaryFetch } from "../src/model/provider.js";
import { DEFAULT_NEXT_ACTIONS, toOperatorErrorEnvelope } from "../src/operator/error-envelope.js";
import { GitLabRoadmapReader } from "../src/roadmap/gitlab-readonly.js";
import { validModelConfig } from "./helpers.js";

const PROXY_VARIABLES = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "ALL_PROXY",
  "all_proxy",
] as const;

/** A runtime that can turn proxy support on but has not. */
const capable = (setGlobalProxyFromEnv = vi.fn(() => () => undefined)): ProxyRuntime => ({
  setGlobalProxyFromEnv,
  execArgv: [],
  nodeOptions: undefined,
  nodeUseEnvProxy: undefined,
});

/** A Node without `http.setGlobalProxyFromEnv`. */
const incapable: ProxyRuntime = {
  setGlobalProxyFromEnv: undefined,
  execArgv: [],
  nodeOptions: undefined,
  nodeUseEnvProxy: undefined,
};

const CANARY = "CANARYPW";
const PROXY = "http://proxy.example.test:3128";

beforeEach(() => {
  // Each case states its own proxy settings; the worker's must not leak in.
  for (const name of PROXY_VARIABLES) vi.stubEnv(name, undefined);
  resetOutboundProxyStateForTests();
  // In-process cases never turn proxy support on for the test worker.
  const dispatcher = (globalThis as Record<symbol, unknown>)[
    Symbol.for("undici.globalDispatcher.1")
  ];
  expect(dispatcher?.constructor.name).not.toBe("EnvHttpProxyAgent");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetOutboundProxyStateForTests();
});

/** A global fetch that records and never sends. */
function trapGlobalFetch() {
  const trap = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", trap);
  return trap;
}

async function refusalOf(promise: Promise<unknown>): Promise<OutboundProxyRefusal> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(OutboundProxyRefusal);
    return error as OutboundProxyRefusal;
  }
  throw new Error("expected an outbound proxy refusal");
}

describe("outbound proxy resolver", () => {
  it.each([
    ["not a url", "contains whitespace inside the URL"],
    ["://no-scheme", "is not a URL"],
    ["socks5://h:1", "names a SOCKS proxy"],
    ["ftp://proxy.example.test:21", "uses a scheme other than http:// or https://"],
    ["http://", "is not a URL"],
    ["proxy.example:3128", "has no scheme; prefix it with http://"],
    ["http://pro xy:3128", "contains whitespace inside the URL"],
    [`http://user:${CANARY}@pro xy:3128`, "contains whitespace inside the URL"],
    ["http://proxy:3128\r\nx-injected: 1", "contains a line break"],
    ["http://proxy:3128\n", "contains a line break"],
    // The Node proxy agent decodes userinfo and throws on these at enable time.
    [`http://user:${CANARY}%ss@proxy.example.test:3128`, "an invalid percent escape"],
    [`http://us%er:${CANARY}@proxy.example.test:3128`, "an invalid percent escape"],
    [`http://user:${CANARY}%E0%A4%A@proxy.example.test:3128`, "an invalid percent escape"],
    [`http://user:${CANARY}%@proxy.example.test:3128`, "an invalid percent escape"],
  ])("refuses %j by naming the variable, never the value", (value, problem) => {
    for (const name of ["http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY"] as const) {
      const resolution = resolveOutboundProxy({ [name]: value });
      expect(resolution.issues).toEqual([
        { variable: name, problem: expect.stringContaining(problem) },
      ]);
      const scheme = name.toLowerCase().startsWith("https") ? resolution.https : resolution.http;
      expect(scheme).toMatchObject({ state: "invalid", variable: name, proxy: null });
      expect(JSON.stringify(resolution)).not.toContain(CANARY);
    }
  });

  it.each([
    [" http://proxy.example.test:3128 ", "http://proxy.example.test:3128"],
    ["http://proxy.example.test:3128/", "http://proxy.example.test:3128"],
    ["HTTP://Proxy.Example.Test:3128", "http://proxy.example.test:3128"],
    ["http://proxy.example.test", "http://proxy.example.test:80"],
    ["https://proxy.example.test", "https://proxy.example.test:443"],
    ["http://[fd00::1]:3128", "http://[fd00::1]:3128"],
    [`http://us%40er:${CANARY}%21@proxy.example.test:3128`, "http://proxy.example.test:3128"],
    // Only userinfo is decoded by Node; a literal %25 there, or a bad escape
    // outside it, is not refused.
    [`http://user:${CANARY}%25@proxy.example.test:3128`, "http://proxy.example.test:3128"],
    ["http://proxy.example.test:3128/%zz", "http://proxy.example.test:3128"],
  ])("accepts %j and shows it as %s without userinfo", (value, shown) => {
    const resolution = resolveOutboundProxy({ HTTPS_PROXY: value });
    expect(resolution.issues).toEqual([]);
    expect(resolution.https).toMatchObject({
      state: "proxy",
      variable: "HTTPS_PROXY",
      proxy: shown,
    });
    expect(JSON.stringify(resolution)).not.toContain(CANARY);
  });

  it("lets lower case win when both names differ, and says so", () => {
    const resolution = resolveOutboundProxy({
      https_proxy: "http://lower.example.test:1",
      HTTPS_PROXY: "http://upper.example.test:2",
    });
    expect(resolution.https).toMatchObject({
      variable: "https_proxy",
      proxy: "http://lower.example.test:1",
    });
    expect(resolution.notices).toContain("https_proxy and HTTPS_PROXY differ; https_proxy wins.");
    const same = resolveOutboundProxy({ https_proxy: PROXY, HTTPS_PROXY: `${PROXY}/` });
    expect(same.notices).toEqual([]);
  });

  it("refuses an empty lower-case name that hides a set upper-case one", () => {
    const resolution = resolveOutboundProxy({ https_proxy: "", HTTPS_PROXY: PROXY });
    expect(resolution.https).toMatchObject({ state: "invalid", variable: "https_proxy" });
    expect(resolution.issues[0]?.problem).toContain("set but empty beside HTTPS_PROXY");
    // Adjacent: an empty upper-case name beside a set lower-case one is harmless.
    const adjacent = resolveOutboundProxy({ https_proxy: PROXY, HTTPS_PROXY: "" });
    expect(adjacent.issues).toEqual([]);
    expect(adjacent.https).toMatchObject({ state: "proxy", variable: "https_proxy" });
  });

  it("refuses a scheme when the name that loses precedence is invalid", () => {
    const resolution = resolveOutboundProxy({
      https_proxy: PROXY,
      HTTPS_PROXY: `http://user:${CANARY}@pro xy:3128`,
    });
    expect(resolution.https).toMatchObject({ state: "invalid", variable: "HTTPS_PROXY" });
    expect(JSON.stringify(resolution)).not.toContain(CANARY);
  });

  it("keeps an invalid http setting from refusing a valid https proxy", () => {
    const resolution = resolveOutboundProxy({ HTTP_PROXY: "socks5://h:1", HTTPS_PROXY: PROXY });
    expect(resolution.http.state).toBe("invalid");
    expect(resolution.https).toMatchObject({ state: "proxy", variable: "HTTPS_PROXY" });
  });

  it("sends https through the http proxy when no https proxy is set, as Node's fetch does", () => {
    const resolution = resolveOutboundProxy({ HTTP_PROXY: PROXY });
    expect(resolution.https).toMatchObject({
      state: "proxy",
      variable: "HTTP_PROXY",
      inheritedFromHttp: true,
    });
    expect(resolution.notices.join(" ")).toContain("node:http sends them direct");
  });

  it("notes ALL_PROXY as ignored", () => {
    expect(resolveOutboundProxy({ ALL_PROXY: PROXY }).notices).toContain(
      "ALL_PROXY is set and ignored; set HTTPS_PROXY or HTTP_PROXY instead.",
    );
  });
});

describe("NO_PROXY matching on the fetch path", () => {
  it.each([
    ["https://models.example.test/v1", "models.example.test", true],
    ["https://api.models.example.test/v1", ".example.test", true],
    ["https://api.models.example.test/v1", "*.example.test", true],
    ["https://example.test/v1", ".example.test", true],
    ["https://badexample.test/v1", "example.test", false],
    ["https://example.test/v1", "example.test", true],
    ["https://host.example.test:8443/v1", "host.example.test:8443", true],
    ["https://host.example.test/v1", "host.example.test:8443", false],
    ["https://host.example.test/v1", "host.example.test:443", true],
    ["https://any.example.test/v1", "*", true],
    ["https://any.example.test/v1", "other.test  , any.example.test", true],
    ["https://unlisted.example.test/v1", "other.test,more.test", false],
  ])("%s with NO_PROXY=%j bypasses=%s", (target, noProxy, bypassed) => {
    expect(isBypassedByNoProxy(new URL(target), noProxy)).toBe(bypassed);
  });
});

describe("Node capability", () => {
  it("every Node DocsFab supports has http.setGlobalProxyFromEnv and a clean in-process enable", async () => {
    const http = await import("node:http");
    expect(typeof (http.default as { setGlobalProxyFromEnv?: unknown }).setGlobalProxyFromEnv).toBe(
      "function",
    );
    expect(inspectOutboundProxy({}).support).toBe("available");
  });
});

describe("proxy enable decision", () => {
  it.each([
    [{}, "no-proxy-variable"],
    [{ HTTPS_PROXY: "" }, "no-proxy-variable"],
    [{ NO_PROXY: "example.test" }, "no-proxy-variable"],
    [{ HTTPS_PROXY: "socks5://h:1" }, "no-valid-proxy"],
  ] as const)("does nothing for %j", (env, reason) => {
    expect(proxyEnableDecision(env, capable())).toEqual({ action: "none", reason });
  });

  // Node's fetch reads `no_proxy ?? NO_PROXY`, so an empty lower-case name
  // would hide the list; DocsFab resolves it and hands Node the value itself.
  it.each([
    [{ no_proxy: "", NO_PROXY: "internal.example.test" }, "internal.example.test", "NO_PROXY"],
    [
      { no_proxy: "lower.example.test", NO_PROXY: "upper.example.test" },
      "lower.example.test",
      "no_proxy",
    ],
  ] as const)("resolves NO_PROXY from %j", (noProxyEnv, value, variable) => {
    const env = { HTTPS_PROXY: PROXY, ...noProxyEnv };
    expect(resolveOutboundProxy(env).noProxy).toEqual({ value, variable });
    expect(proxyEnableDecision(env, capable())).toMatchObject({
      action: "enable",
      proxyEnv: { no_proxy: value },
    });
  });

  it("hands Node only the valid values, credentials kept for the proxy", () => {
    const decision = proxyEnableDecision(
      {
        HTTP_PROXY: "socks5://h:1",
        HTTPS_PROXY: `http://user:${CANARY}@proxy.example.test:3128/path`,
        NO_PROXY: "internal.example.test",
      },
      capable(),
    );
    expect(decision).toEqual({
      action: "enable",
      proxyEnv: {
        https_proxy: `http://user:${CANARY}@proxy.example.test:3128`,
        no_proxy: "internal.example.test",
      },
    });
  });

  it("reports a Node without built-in proxy support instead of enabling", () => {
    expect(proxyEnableDecision({ HTTPS_PROXY: PROXY }, incapable)).toEqual({
      action: "unsupported",
    });
  });
});

describe("ensureBuiltInProxy", () => {
  it("calls Node once, with the four names hidden from process.env during the call", () => {
    vi.stubEnv("HTTP_PROXY", "not a url");
    vi.stubEnv("HTTPS_PROXY", PROXY);
    const seen: Array<string | undefined> = [];
    const set = vi.fn((_env: Record<string, string>) => {
      seen.push(process.env.HTTP_PROXY, process.env.HTTPS_PROXY);
      return () => undefined;
    });
    ensureBuiltInProxy(process.env, capable(set));
    ensureBuiltInProxy(process.env, capable(set));
    expect(set).toHaveBeenCalledTimes(1);
    expect(set.mock.calls[0]?.[0]).toEqual({ https_proxy: PROXY });
    expect(seen).toEqual([undefined, undefined]);
    expect(process.env.HTTP_PROXY).toBe("not a url");
    expect(process.env.HTTPS_PROXY).toBe(PROXY);
    expect(inspectOutboundProxy(process.env, capable()).support).toBe("enabled");
  });

  it("turns Node's own proxy-configuration refusal into a coded refusal without the value", async () => {
    vi.stubEnv("HTTPS_PROXY", PROXY);
    const set = vi.fn(() => {
      throw Object.assign(new TypeError(`Invalid proxy URL: http://user:${CANARY}@x`), {
        code: "ERR_PROXY_INVALID_CONFIG",
      });
    });
    expect(() => ensureBuiltInProxy(process.env, capable(set))).not.toThrow();
    const trap = trapGlobalFetch();
    const refusal = await refusalOf(outboundFetch()("https://models.example.test/v1/models"));
    expect(refusal.code).toBe(OUTBOUND_PROXY_INVALID_CODE);
    expect(refusal.message).not.toContain(CANARY);
    expect(trap).not.toHaveBeenCalled();
  });

  it("does not hide an unrelated failure from Node as a proxy refusal", () => {
    vi.stubEnv("HTTPS_PROXY", PROXY);
    const set = vi.fn(() => {
      throw Object.assign(new TypeError("unrelated"), { code: "ERR_INVALID_ARG_TYPE" });
    });
    expect(() => ensureBuiltInProxy(process.env, capable(set))).toThrow("unrelated");
    expect(process.env.HTTPS_PROXY).toBe(PROXY);
  });
});

describe("outboundFetch site check", () => {
  it("refuses a proxied request when proxy support is not turned on, before sending", async () => {
    const trap = trapGlobalFetch();
    const refusal = await refusalOf(
      outboundFetch({ env: { HTTPS_PROXY: PROXY }, runtime: capable() })(
        "https://models.example.test/v1/models",
      ),
    );
    expect(refusal).toMatchObject({
      code: OUTBOUND_PROXY_NOT_ENABLED_CODE,
      kind: "not-enabled",
      variable: "HTTPS_PROXY",
      nextAction: OUTBOUND_PROXY_NOT_ENABLED_NEXT_ACTION,
    });
    expect(refusal.message).toContain("proxy support is not turned on in this process");
    expect(trap).not.toHaveBeenCalled();
  });

  it("names a Node without proxy support in the refusal", async () => {
    const trap = trapGlobalFetch();
    const refusal = await refusalOf(
      outboundFetch({ env: { HTTPS_PROXY: PROXY }, runtime: incapable })(
        "https://models.example.test/v1/models",
      ),
    );
    expect(refusal.code).toBe(OUTBOUND_PROXY_NOT_ENABLED_CODE);
    expect(refusal.message).toContain("this Node.js release has no built-in proxy support");
    expect(trap).not.toHaveBeenCalled();
  });

  it("sends when Node started with proxy support on", async () => {
    const trap = trapGlobalFetch();
    for (const runtime of [
      { ...incapable, execArgv: ["--use-env-proxy"] },
      { ...incapable, nodeUseEnvProxy: "1" },
      { ...incapable, nodeOptions: "--max-old-space-size=4096 --use-env-proxy" },
    ]) {
      await outboundFetch({ env: { HTTPS_PROXY: PROXY }, runtime })(
        "https://models.example.test/v1",
      );
    }
    expect(trap).toHaveBeenCalledTimes(3);
    // Adjacent: a later --no-use-env-proxy wins, and NODE_USE_ENV_PROXY=true is not 1.
    for (const runtime of [
      { ...incapable, nodeOptions: "--use-env-proxy", execArgv: ["--no-use-env-proxy"] },
      { ...incapable, nodeUseEnvProxy: "true" },
    ]) {
      await refusalOf(
        outboundFetch({ env: { HTTPS_PROXY: PROXY }, runtime })("https://models.example.test/v1"),
      );
    }
    expect(trap).toHaveBeenCalledTimes(3);
  });

  it("refuses an invalid setting for the request's scheme only, naming the variable", async () => {
    const trap = trapGlobalFetch();
    const env = { HTTP_PROXY: `http://user:${CANARY}@pro xy:3128`, HTTPS_PROXY: PROXY };
    const runtime = { ...incapable, execArgv: ["--use-env-proxy"] };
    const refusal = await refusalOf(
      outboundFetch({ env, runtime })("http://models.example.test/v1"),
    );
    expect(refusal).toMatchObject({
      code: OUTBOUND_PROXY_INVALID_CODE,
      variable: "HTTP_PROXY",
      nextAction: OUTBOUND_PROXY_INVALID_NEXT_ACTION,
    });
    expect(refusal.message).toContain("HTTP_PROXY contains whitespace inside the URL");
    expect(JSON.stringify(toOperatorErrorEnvelope(refusal))).not.toContain(CANARY);
    expect(trap).not.toHaveBeenCalled();
    await outboundFetch({ env, runtime })("https://models.example.test/v1");
    expect(trap).toHaveBeenCalledTimes(1);
  });

  it("sends a NO_PROXY-bypassed target even when the setting is invalid or not enabled", async () => {
    const trap = trapGlobalFetch();
    await outboundFetch({
      env: { HTTPS_PROXY: "socks5://h:1", NO_PROXY: ".example.test" },
      runtime: capable(),
    })("https://models.example.test/v1");
    await outboundFetch({
      env: { HTTPS_PROXY: PROXY, NO_PROXY: "models.example.test" },
      runtime: capable(),
    })("https://models.example.test/v1");
    expect(trap).toHaveBeenCalledTimes(2);
  });

  it("leaves a request alone when no proxy setting applies to its scheme", async () => {
    const trap = trapGlobalFetch();
    await outboundFetch({ env: { HTTPS_PROXY: "" }, runtime: capable() })(
      "https://models.example.test/",
    );
    await outboundFetch({ env: { NO_PROXY: "x" }, runtime: capable() })(
      "http://models.example.test/",
    );
    expect(trap).toHaveBeenCalledTimes(2);
  });

  it("does not treat names that only contain a loopback label as loopback", async () => {
    const trap = trapGlobalFetch();
    for (const target of [
      "https://localhost.example.test/v1",
      "https://127.0.0.1.example.test/v1",
      "https://[::2]/v1",
    ]) {
      const refusal = await refusalOf(
        outboundFetch({ env: { HTTPS_PROXY: PROXY }, runtime: capable() })(target),
      );
      expect(refusal.code).toBe(OUTBOUND_PROXY_NOT_ENABLED_CODE);
    }
    expect(trap).not.toHaveBeenCalled();
  });

  it("routes loopback through the pinned transport, never the global fetch", async () => {
    const trap = trapGlobalFetch();
    // Nothing listens on port 9; the pinned transport's connect error proves
    // the route without a server, and the trap proves the global fetch was skipped.
    for (const target of ["https://127.0.0.1:9/v1", "http://127.0.0.1:9/v1"]) {
      await expect(
        outboundFetch({
          env: { HTTPS_PROXY: "socks5://h:1", HTTP_PROXY: PROXY },
          runtime: capable(),
        })(target),
      ).rejects.toMatchObject({ code: "ECONNREFUSED" });
    }
    expect(trap).not.toHaveBeenCalled();
  });
});

describe("loopback HTTPS transport", () => {
  it.each([[["203.0.113.7"]], [["127.0.0.1", "10.0.0.5"]], [[]]] as const)(
    "refuses a localhost that resolves to %j",
    async (addresses) => {
      await expect(
        createLoopbackHttpsFetch(async () => addresses)("https://localhost:9/v1"),
      ).rejects.toBeInstanceOf(LoopbackResolutionRefusal);
    },
  );
});

describe("default fetch at each outbound site", () => {
  const proxied = () => {
    vi.stubEnv("HTTPS_PROXY", PROXY);
    return trapGlobalFetch();
  };

  it("provider boundary default (model requests)", async () => {
    const trap = proxied();
    const refusal = await refusalOf(
      createProviderBoundaryFetch("https://models.example.test/v1")(
        "https://models.example.test/v1/chat/completions",
        { method: "POST", body: "{}" },
      ),
    );
    expect(refusal.code).toBe(OUTBOUND_PROXY_NOT_ENABLED_CODE);
    expect(trap).not.toHaveBeenCalled();
  });

  it("an injected fetch is never wrapped", async () => {
    proxied();
    const injected = vi.fn(async () => new Response(null, { status: 204 }));
    const response = await createProviderBoundaryFetch(
      "https://models.example.test/v1",
      injected,
    )("https://models.example.test/v1/chat/completions");
    expect(response.status).toBe(204);
    expect(injected).toHaveBeenCalledTimes(1);
  });

  it("OpenAI API catalog discovery", async () => {
    const trap = proxied();
    const refusal = await refusalOf(
      discoverOpenaiApiModelCatalog({ config: openaiConfig(), purpose: "policy" }),
    );
    expect(refusal.code).toBe(OUTBOUND_PROXY_NOT_ENABLED_CODE);
    expect(trap).not.toHaveBeenCalled();
  });

  it("NVIDIA Inference catalog discovery", async () => {
    const trap = proxied();
    const refusal = await refusalOf(
      discoverNvidiaInferenceModelCatalog({ config: nvidiaConfig(), purpose: "policy" }),
    );
    expect(refusal.code).toBe(OUTBOUND_PROXY_NOT_ENABLED_CODE);
    expect(trap).not.toHaveBeenCalled();
  });

  it("profile inspection fails with the refusal instead of an unavailable catalog", async () => {
    const trap = proxied();
    const refusal = await refusalOf(
      inspectModelProfile(
        { model: openaiConfig() } as never,
        {
          purpose: "policy",
          catalog: true,
        } as never,
      ),
    );
    expect(refusal.code).toBe(OUTBOUND_PROXY_NOT_ENABLED_CODE);
    expect(trap).not.toHaveBeenCalled();
  });

  it.each([
    [PROXY, OUTBOUND_PROXY_NOT_ENABLED_CODE],
    ["socks5://h:1", OUTBOUND_PROXY_INVALID_CODE],
  ])(
    "profile inspection on the NVIDIA route fails with the refusal for HTTPS_PROXY=%s",
    async (value, code) => {
      vi.stubEnv("HTTPS_PROXY", value);
      const trap = trapGlobalFetch();
      const refusal = await refusalOf(
        inspectModelProfile(
          { model: nvidiaConfig() } as never,
          { purpose: "policy", catalog: true } as never,
        ),
      );
      expect(refusal.code).toBe(code);
      expect(trap).not.toHaveBeenCalled();
    },
  );

  it("Inference Hub metadata", async () => {
    const trap = proxied();
    const refusal = await refusalOf(inspectInferenceHubMetadata(metadataInspection()));
    expect(trap).not.toHaveBeenCalled();
    expect(refusal.code).toBe(OUTBOUND_PROXY_NOT_ENABLED_CODE);
  });

  it("GitLab roadmap reader", async () => {
    const trap = proxied();
    const project = {
      provider: "gitlab" as const,
      host: "gitlab.example.com",
      fullPath: "group/project",
      projectId: 7,
    };
    const refusal = await refusalOf(
      new GitLabRoadmapReader({ project, token: "t" }).observe(project),
    );
    expect(refusal.code).toBe(OUTBOUND_PROXY_NOT_ENABLED_CODE);
    expect(trap).not.toHaveBeenCalled();
  });
});

describe("Inference Hub metadata keeps a proxy refusal's own code", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("an invalid setting read by the default fetch sends nothing", async () => {
    vi.stubEnv("HTTPS_PROXY", "socks5://h:1");
    const trap = trapGlobalFetch();
    const refusal = await refusalOf(inspectInferenceHubMetadata(metadataInspection()));
    expect(refusal.code).toBe(OUTBOUND_PROXY_INVALID_CODE);
    expect(refusal.nextAction).toBe(OUTBOUND_PROXY_INVALID_NEXT_ACTION);
    expect(trap).not.toHaveBeenCalled();
  });

  it.each([
    ["unreachable", OUTBOUND_PROXY_UNREACHABLE_CODE],
    ["denied", OUTBOUND_PROXY_DENIED_CODE],
    ["auth-required", OUTBOUND_PROXY_AUTH_REQUIRED_CODE],
  ] as const)("a %s proxy reaches the caller unchanged", async (kind, code) => {
    const thrown = new OutboundProxyRefusal(kind, `Scripted refusal (${code}).`, "HTTPS_PROXY");
    const send = vi.fn(async () => {
      throw thrown;
    });
    const refusal = await refusalOf(
      inspectInferenceHubMetadata(metadataInspection({ fetch: send as typeof globalThis.fetch })),
    );
    expect(refusal).toBe(thrown);
    expect(refusal.code).toBe(code);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("positive control: a 200 reply observes the record", async () => {
    const result = await inspectInferenceHubMetadata(
      metadataInspection({
        fetch: (async () =>
          new Response(
            JSON.stringify({
              models: [
                {
                  label: METADATA_LABEL,
                  provider_id: "azure",
                  status: "active",
                  capabilities: { reasoning: true, chat: true, input_modalities: ["text"] },
                  limits: { context_length: 128_000, max_output_tokens: 32_000 },
                  pricing: null,
                },
              ],
              next_cursor: null,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          )) as typeof globalThis.fetch,
      }),
    );
    expect(result.status).toBe("observed");
  });

  it("adjacent: any other thrown error is still a failed request", async () => {
    const error = await inspectInferenceHubMetadata(
      metadataInspection({
        fetch: (async () => {
          throw new TypeError("fetch failed");
        }) as typeof globalThis.fetch,
      }),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InferenceHubMetadataError);
    expect(error).toMatchObject({ code: "request-failed" });
  });

  it("adjacent: a refusal that settles after the timer fired is still a timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // Holds the request until the adapter's own timer aborts it, then fails it
    // with a refusal: the abort race has already rejected by then.
    const send = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new OutboundProxyRefusal("denied", "Scripted late refusal.")),
            { once: true },
          );
        }),
    );
    const pending = inspectInferenceHubMetadata(
      metadataInspection({ fetch: send as typeof globalThis.fetch }),
    ).catch((caught: unknown) => caught);
    await vi.runOnlyPendingTimersAsync();
    const error = await pending;
    expect(send).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(InferenceHubMetadataError);
    expect(error).toMatchObject({ code: "request-timeout" });
  });
});

describe("a governed model turn with an invalid proxy setting", () => {
  it("sends nothing and is not replayed", async () => {
    vi.stubEnv("HTTPS_PROXY", "socks5://h:1");
    const trap = trapGlobalFetch();
    const connection = await createModelConnection(validModelConfig, {
      evidenceIdentity: { repositoryRevision: "a".repeat(40) },
      providerTurnRetry: { baseDelayMs: 0, maxDelayMs: 0 },
    });
    const stream = connection.runtime.streamSimple(
      connection.model,
      {
        systemPrompt: "Proxy refusal test.",
        messages: [{ role: "user", content: "Reply OK.", timestamp: 1 }],
        tools: [],
      },
      undefined,
    );
    for await (const _event of stream as AsyncIterable<unknown>) {
      // Drain; the turn ends in an error event.
    }
    expect(trap).not.toHaveBeenCalled();
    expect(connection.physicalProviderAttempts?.spent()).toBe(1);
  });
});

describe("situation catalog and doctor rendering", () => {
  it("keeps catalog next actions equal to the refusal's own", () => {
    expect(DEFAULT_NEXT_ACTIONS[OUTBOUND_PROXY_INVALID_CODE]).toBe(
      OUTBOUND_PROXY_INVALID_NEXT_ACTION,
    );
    expect(DEFAULT_NEXT_ACTIONS[OUTBOUND_PROXY_NOT_ENABLED_CODE]).toBe(
      OUTBOUND_PROXY_NOT_ENABLED_NEXT_ACTION,
    );
    for (const kind of ["invalid", "not-enabled"] as const) {
      const envelope = toOperatorErrorEnvelope(
        new OutboundProxyRefusal(kind, "refused", "HTTPS_PROXY"),
      );
      expect(envelope).toMatchObject({
        code: `outbound-proxy-${kind}`,
        docsAnchor: "docs/about/security.md",
        failure: { class: "operator-input" },
      });
    }
  });

  it("renders each scheme, NO_PROXY, and support without credentials", () => {
    const lines = formatOutboundProxy(
      inspectOutboundProxy(
        {
          HTTPS_PROXY: `http://user:${CANARY}@proxy.example.test:3128`,
          HTTP_PROXY: "socks5://h:1",
          no_proxy: "internal.example.test",
          ALL_PROXY: PROXY,
        },
        incapable,
      ),
    ).join("\n");
    expect(lines).toContain("https: http://proxy.example.test:3128 (from HTTPS_PROXY)");
    expect(lines).toContain("http: refused (HTTP_PROXY)");
    expect(lines).toContain("NO_PROXY: internal.example.test (from no_proxy)");
    expect(lines).toContain("Built-in proxy support: unsupported by this Node.js release");
    expect(lines).toContain("ALL_PROXY is set and ignored");
    expect(lines).not.toContain(CANARY);
    expect(lines).not.toContain(Buffer.from(`user:${CANARY}`).toString("base64"));
    expect(formatOutboundProxy(inspectOutboundProxy({}, capable())).join("\n")).toContain(
      "https: none",
    );
  });
});

const METADATA_LABEL = "azure/openai/gpt-5.4";

function metadataInspection(
  overrides: Partial<InferenceHubMetadataInspection> = {},
): InferenceHubMetadataInspection {
  return {
    requested: true,
    authority: "authenticated",
    purpose: "policy",
    label: METADATA_LABEL,
    endpoint: {
      origin: "https://metadata.example.test",
      path: "/v1/catalog/search",
      mode: "search",
    },
    environment: { INFERENCE_HUB_METADATA_API_KEY: `ihub_api_${"A".repeat(24)}` },
    ...overrides,
  };
}

function openaiConfig(): ModelEndpointConfig {
  return {
    ...structuredClone(validModelConfig),
    providerId: "openai",
    baseUrl: "https://api.openai.com/v1",
    modelId: "gpt-5.4",
    apiKey: `sk-${"A".repeat(24)}`,
  };
}

function nvidiaConfig(): ModelEndpointConfig {
  return {
    ...structuredClone(validModelConfig),
    providerId: "nvidia",
    baseUrl: `${NVIDIA_INFERENCE_CATALOG_ORIGIN}/v1`,
    modelId: "openai/gpt-5.4",
    apiKey: `nvapi-${"A".repeat(24)}`,
  };
}
