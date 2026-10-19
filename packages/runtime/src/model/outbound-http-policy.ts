// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import http from "node:http";

import { isLoopbackHostname } from "./endpoint-transport.js";
import { createLoopbackHttpFetch, createLoopbackHttpsFetch } from "./loopback-http-fetch.js";
import { classifyProxyFailure, type ProxyFailure } from "./outbound-proxy-classifier.js";

/**
 * One outbound HTTP policy for DocsFab's own requests: which proxy each request
 * uses, when Node's built-in proxy support is turned on, and the named
 * refusals. Doctor, the shipped entries, and every default fetch read the same
 * resolver, so they cannot disagree about the effective proxy.
 */

export const OUTBOUND_PROXY_INVALID_CODE = "outbound-proxy-invalid" as const;
export const OUTBOUND_PROXY_NOT_ENABLED_CODE = "outbound-proxy-not-enabled" as const;
export const OUTBOUND_PROXY_UNREACHABLE_CODE = "outbound-proxy-unreachable" as const;
export const OUTBOUND_PROXY_DENIED_CODE = "outbound-proxy-denied" as const;
export const OUTBOUND_PROXY_AUTH_REQUIRED_CODE = "outbound-proxy-auth-required" as const;

/** Same text as the `outbound-proxy-invalid` situation catalog rows. */
export const OUTBOUND_PROXY_INVALID_NEXT_ACTION =
  "Set the named proxy variable to an http:// or https:// proxy URL with a host, for example http://proxy.example.com:3128, or unset it, or add the target host to NO_PROXY; then run docsfab doctor and retry.";

/** Same text as the `outbound-proxy-not-enabled` situation catalog rows. */
export const OUTBOUND_PROXY_NOT_ENABLED_NEXT_ACTION =
  "Run DocsFab through the docsfab command on the Node.js release DocsFab requires, which turns on Node's built-in proxy support, or start Node with --use-env-proxy; otherwise unset the proxy variable or add the target host to NO_PROXY, then retry.";

/** Same text as the `outbound-proxy-unreachable` situation catalog rows. */
export const OUTBOUND_PROXY_UNREACHABLE_NEXT_ACTION =
  "Check that the proxy named by HTTPS_PROXY or HTTP_PROXY is running and reachable from this machine and that the variable names its host and port, or add the target host to NO_PROXY to connect directly; then run docsfab doctor --live and retry.";

/** Same text as the `outbound-proxy-denied` situation catalog rows. */
export const OUTBOUND_PROXY_DENIED_NEXT_ACTION =
  "Ask the proxy administrator to allow the target host, or set HTTPS_PROXY or HTTP_PROXY to a proxy that allows it, or add the target host to NO_PROXY to connect directly; then retry.";

/** Same text as the `outbound-proxy-auth-required` situation catalog rows. */
export const OUTBOUND_PROXY_AUTH_REQUIRED_NEXT_ACTION =
  "Add the proxy user name and password to the proxy URL in HTTPS_PROXY or HTTP_PROXY, written as user:password@ before the proxy host with reserved characters percent-encoded, or use a proxy that needs no authentication; then retry.";

export type OutboundProxyRefusalKind =
  | "invalid"
  | "not-enabled"
  | "unreachable"
  | "denied"
  | "auth-required";

/** Code and next action per kind; a new kind without a row does not compile. */
const REFUSAL_KINDS: {
  readonly [K in OutboundProxyRefusalKind]: {
    readonly code: `outbound-proxy-${K}`;
    readonly nextAction: string;
  };
} = {
  invalid: {
    code: OUTBOUND_PROXY_INVALID_CODE,
    nextAction: OUTBOUND_PROXY_INVALID_NEXT_ACTION,
  },
  "not-enabled": {
    code: OUTBOUND_PROXY_NOT_ENABLED_CODE,
    nextAction: OUTBOUND_PROXY_NOT_ENABLED_NEXT_ACTION,
  },
  unreachable: {
    code: OUTBOUND_PROXY_UNREACHABLE_CODE,
    nextAction: OUTBOUND_PROXY_UNREACHABLE_NEXT_ACTION,
  },
  denied: {
    code: OUTBOUND_PROXY_DENIED_CODE,
    nextAction: OUTBOUND_PROXY_DENIED_NEXT_ACTION,
  },
  "auth-required": {
    code: OUTBOUND_PROXY_AUTH_REQUIRED_CODE,
    nextAction: OUTBOUND_PROXY_AUTH_REQUIRED_NEXT_ACTION,
  },
};

export type ProxyVariable = "http_proxy" | "HTTP_PROXY" | "https_proxy" | "HTTPS_PROXY";
export type NoProxyVariable = "no_proxy" | "NO_PROXY";

const PROXY_VARIABLES: readonly ProxyVariable[] = [
  "http_proxy",
  "HTTP_PROXY",
  "https_proxy",
  "HTTPS_PROXY",
];

/** Protocol default ports, shown when a proxy URL names none. Not bounds. */
const DEFAULT_PORTS: Readonly<Record<"http:" | "https:", number>> = {
  "http:": 80,
  "https:": 443,
};

/**
 * DocsFab refused an outbound request before sending it, or the proxy could
 * not be reached or refused the tunnel, so nothing reached the target. The
 * message names the variable, never its value, so a proxy credential cannot
 * reach the operator.
 */
export class OutboundProxyRefusal extends Error {
  public readonly code: `outbound-proxy-${OutboundProxyRefusalKind}`;
  public readonly kind: OutboundProxyRefusalKind;
  public readonly nextAction: string;
  public readonly variable: ProxyVariable | undefined;

  public constructor(kind: OutboundProxyRefusalKind, message: string, variable?: ProxyVariable) {
    super(message);
    this.name = "OutboundProxyRefusal";
    this.kind = kind;
    this.code = REFUSAL_KINDS[kind].code;
    this.nextAction = REFUSAL_KINDS[kind].nextAction;
    this.variable = variable;
  }
}

export interface OutboundProxyIssue {
  readonly variable: ProxyVariable;
  /** Completes "<variable> ..."; never contains the value. */
  readonly problem: string;
}

export interface SchemeProxy {
  readonly state: "none" | "proxy" | "invalid";
  /** The variable that supplies the proxy, or the first one refused. */
  readonly variable: ProxyVariable | null;
  /** `scheme://host:port`, without userinfo or path. */
  readonly proxy: string | null;
}

export interface OutboundProxyResolution {
  readonly http: SchemeProxy;
  /** What Node's fetch uses for https: the https pair, else the http proxy. */
  readonly https: SchemeProxy & { readonly inheritedFromHttp: boolean };
  readonly noProxy: { readonly value: string; readonly variable: NoProxyVariable } | null;
  readonly issues: readonly OutboundProxyIssue[];
  /** Non-failing differences an operator should know about. */
  readonly notices: readonly string[];
}

type CheckedValue = { ok: true; url: URL } | { ok: false; problem: string };

/** `host:port` with no scheme, which the WHATWG parser reads as scheme `host:`. */
const SCHEME_LESS = /^[A-Za-z0-9.-]+:\d+(?:\/.*)?$/u;

function checkProxyValue(raw: string): CheckedValue {
  if (/[\r\n]/u.test(raw)) return { ok: false, problem: "contains a line break" };
  // Node's URL parser trims surrounding whitespace, so only interior
  // whitespace makes a different URL from the one the operator typed.
  const trimmed = raw.trim();
  if (/\s/u.test(trimmed)) return { ok: false, problem: "contains whitespace inside the URL" };
  if (SCHEME_LESS.test(trimmed)) {
    return { ok: false, problem: "has no scheme; prefix it with http://" };
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, problem: "is not a URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      ok: false,
      problem: url.protocol.startsWith("socks")
        ? "names a SOCKS proxy; only http:// and https:// proxies are supported"
        : "uses a scheme other than http:// or https://",
    };
  }
  if (url.hostname === "") return { ok: false, problem: "has no host" };
  if (!decodableUserinfo(url)) {
    return {
      ok: false,
      problem: "has a user name or password with an invalid percent escape; write % as %25",
    };
  }
  return { ok: true, url };
}

/**
 * Node's proxy agent percent-decodes the user name and password when proxy
 * support is turned on and throws on a bad escape, which would stop every
 * command at startup. Only userinfo is decoded there; path, query and host
 * escapes are not, so they are left alone.
 */
function decodableUserinfo(url: URL): boolean {
  try {
    decodeURIComponent(url.username);
    decodeURIComponent(url.password);
    return true;
  } catch {
    return false;
  }
}

function displayProxy(url: URL): string {
  const protocol = url.protocol as "http:" | "https:";
  return `${protocol}//${url.hostname}:${url.port || String(DEFAULT_PORTS[protocol])}`;
}

/** The URL handed to Node: normalized, credentials kept, path dropped. */
function nodeProxyValue(url: URL): string {
  const userinfo =
    url.username || url.password ? `${url.username}${url.password ? `:${url.password}` : ""}@` : "";
  return `${url.protocol}//${userinfo}${url.host}`;
}

function nonEmpty(value: string | undefined): value is string {
  return value !== undefined && value !== "";
}

interface SchemeResult {
  readonly scheme: SchemeProxy;
  readonly issues: OutboundProxyIssue[];
  readonly notices: string[];
  readonly nodeValue: string | null;
}

function resolveScheme(env: NodeJS.ProcessEnv, scheme: "http" | "https"): SchemeResult {
  const lowerName = `${scheme}_proxy` as ProxyVariable;
  const upperName = `${scheme.toUpperCase()}_PROXY` as ProxyVariable;
  const lower = env[lowerName];
  const upper = env[upperName];
  const issues: OutboundProxyIssue[] = [];
  const notices: string[] = [];
  const checked = new Map<ProxyVariable, URL>();
  // Both names are checked: Node's fetch and node:http pick between them
  // differently, so a bad value in either one can decide where a request goes.
  for (const name of [lowerName, upperName]) {
    const value = env[name];
    if (!nonEmpty(value)) continue;
    const result = checkProxyValue(value);
    if (result.ok) checked.set(name, result.url);
    else issues.push({ variable: name, problem: result.problem });
  }
  if (lower === "" && nonEmpty(upper)) {
    issues.push({
      variable: lowerName,
      problem: `is set but empty beside ${upperName}; Node's fetch and node:http read that pair differently`,
    });
  }
  if (issues.length > 0) {
    return {
      scheme: { state: "invalid", variable: issues[0]!.variable, proxy: null },
      issues,
      notices,
      nodeValue: null,
    };
  }
  const variable = checked.has(lowerName) ? lowerName : checked.has(upperName) ? upperName : null;
  if (variable === null) {
    return {
      scheme: { state: "none", variable: null, proxy: null },
      issues,
      notices,
      nodeValue: null,
    };
  }
  const url = checked.get(variable)!;
  if (variable === lowerName && checked.has(upperName)) {
    const other = checked.get(upperName)!;
    if (nodeProxyValue(other) !== nodeProxyValue(url)) {
      notices.push(`${lowerName} and ${upperName} differ; ${lowerName} wins.`);
    }
  }
  return {
    scheme: { state: "proxy", variable, proxy: displayProxy(url) },
    issues,
    notices,
    nodeValue: nodeProxyValue(url),
  };
}

function resolveNoProxy(env: NodeJS.ProcessEnv): OutboundProxyResolution["noProxy"] {
  if (nonEmpty(env.no_proxy)) return { value: env.no_proxy, variable: "no_proxy" };
  if (nonEmpty(env.NO_PROXY)) return { value: env.NO_PROXY, variable: "NO_PROXY" };
  return null;
}

interface FullResolution {
  readonly resolution: OutboundProxyResolution;
  /** Only valid proxy values plus the bypass list; this is all Node ever sees. */
  readonly proxyEnv: Record<string, string>;
}

function resolveFull(env: NodeJS.ProcessEnv): FullResolution {
  const httpResult = resolveScheme(env, "http");
  const httpsResult = resolveScheme(env, "https");
  const inherited = httpsResult.scheme.state === "none" && httpResult.scheme.state !== "none";
  const noProxy = resolveNoProxy(env);
  const notices = [...httpResult.notices, ...httpsResult.notices];
  if (inherited && httpResult.scheme.state === "proxy") {
    notices.push(
      "No https proxy is set, so Node's fetch sends https requests through the http proxy; node:http sends them direct.",
    );
  }
  if (nonEmpty(env.ALL_PROXY) || nonEmpty(env.all_proxy)) {
    notices.push("ALL_PROXY is set and ignored; set HTTPS_PROXY or HTTP_PROXY instead.");
  }
  const proxyEnv: Record<string, string> = {};
  if (httpResult.nodeValue) proxyEnv.http_proxy = httpResult.nodeValue;
  if (httpsResult.nodeValue) proxyEnv.https_proxy = httpsResult.nodeValue;
  if (noProxy) proxyEnv.no_proxy = noProxy.value;
  return {
    resolution: {
      http: httpResult.scheme,
      https: inherited
        ? { ...httpResult.scheme, inheritedFromHttp: true }
        : { ...httpsResult.scheme, inheritedFromHttp: false },
      noProxy,
      issues: [...httpResult.issues, ...httpsResult.issues],
      notices,
    },
    proxyEnv,
  };
}

/** The effective proxy for each scheme, as DocsFab's fetch path uses it. */
export function resolveOutboundProxy(
  env: NodeJS.ProcessEnv = process.env,
): OutboundProxyResolution {
  return resolveFull(env).resolution;
}

type SetGlobalProxyFromEnv = (proxyEnv: Record<string, string>) => () => void;

/** The live process facts the enable decision reads; tests inject their own. */
export interface ProxyRuntime {
  /** Node's in-process switch; absent on a Node without built-in proxy support. */
  readonly setGlobalProxyFromEnv: SetGlobalProxyFromEnv | undefined;
  readonly execArgv: readonly string[];
  readonly nodeOptions: string | undefined;
  readonly nodeUseEnvProxy: string | undefined;
}

// Node reads these once at startup; setting them later changes nothing, so the
// policy reads the values this process started with.
const STARTUP_NODE_OPTIONS = process.env.NODE_OPTIONS;
const STARTUP_NODE_USE_ENV_PROXY = process.env.NODE_USE_ENV_PROXY;

function liveRuntime(): ProxyRuntime {
  const candidate = (http as unknown as { setGlobalProxyFromEnv?: unknown }).setGlobalProxyFromEnv;
  return {
    setGlobalProxyFromEnv:
      typeof candidate === "function" ? (candidate as SetGlobalProxyFromEnv) : undefined,
    execArgv: process.execArgv,
    nodeOptions: STARTUP_NODE_OPTIONS,
    nodeUseEnvProxy: STARTUP_NODE_USE_ENV_PROXY,
  };
}

/** True when Node itself started with built-in proxy support on. */
function startedWithProxySupport(runtime: ProxyRuntime): boolean {
  const tokens = [...(runtime.nodeOptions?.split(/\s+/u) ?? []), ...runtime.execArgv];
  let flag: boolean | undefined;
  for (const token of tokens) {
    if (token === "--use-env-proxy") flag = true;
    else if (token === "--no-use-env-proxy") flag = false;
  }
  return flag ?? runtime.nodeUseEnvProxy === "1";
}

export type ProxyEnableDecision =
  | { readonly action: "none"; readonly reason: "no-proxy-variable" | "no-valid-proxy" }
  | { readonly action: "unsupported" }
  | { readonly action: "enable"; readonly proxyEnv: Readonly<Record<string, string>> };

/** Whether `ensureBuiltInProxy` would turn on Node's proxy support, and with what. */
export function proxyEnableDecision(
  env: NodeJS.ProcessEnv = process.env,
  runtime: ProxyRuntime = liveRuntime(),
): ProxyEnableDecision {
  if (!PROXY_VARIABLES.some((name) => nonEmpty(env[name]))) {
    return { action: "none", reason: "no-proxy-variable" };
  }
  const { proxyEnv } = resolveFull(env);
  if (!proxyEnv.http_proxy && !proxyEnv.https_proxy) {
    return { action: "none", reason: "no-valid-proxy" };
  }
  if (!runtime.setGlobalProxyFromEnv) return { action: "unsupported" };
  return { action: "enable", proxyEnv: Object.freeze({ ...proxyEnv }) };
}

let enabled = false;
let enableAttempted = false;
let enableFailure: OutboundProxyRefusal | undefined;
/** What `ensureBuiltInProxy` installed, so a later replacement can be undone. */
let installed:
  | { proxyEnv: Readonly<Record<string, string>>; runtime: ProxyRuntime; dispatcher: unknown }
  | undefined;

/** The slot Node's fetch reads its global dispatcher from. */
const GLOBAL_DISPATCHER = Symbol.for("undici.globalDispatcher.1");

function currentDispatcher(): unknown {
  return (globalThis as Record<symbol, unknown>)[GLOBAL_DISPATCHER];
}

function applyBuiltInProxy(
  proxyEnv: Readonly<Record<string, string>>,
  runtime: ProxyRuntime,
): void {
  // Node's fetch dispatcher falls back to process.env for a scheme the object
  // leaves out, which would bring a refused value back. Hide the four names
  // for the duration of the synchronous call only.
  const hidden = new Map<string, string>();
  for (const name of PROXY_VARIABLES) {
    const value = process.env[name];
    if (value !== undefined) {
      hidden.set(name, value);
      delete process.env[name];
    }
  }
  try {
    runtime.setGlobalProxyFromEnv!({ ...proxyEnv });
  } finally {
    for (const [name, value] of hidden) process.env[name] = value;
  }
  installed = { proxyEnv, runtime, dispatcher: currentDispatcher() };
}

/**
 * Turn on Node's built-in proxy support for this process, once, from the valid
 * proxy variables only. An invalid variable is left out, so its scheme stays
 * unproxied and `outboundFetch` refuses it by name; a missing capability is
 * left to `outboundFetch` too, so commands that send nothing still run. Called
 * by the shipped entries, never by library imports.
 */
export function ensureBuiltInProxy(
  env: NodeJS.ProcessEnv = process.env,
  runtime: ProxyRuntime = liveRuntime(),
): ProxyEnableDecision {
  const decision = proxyEnableDecision(env, runtime);
  if (enableAttempted || decision.action !== "enable") return decision;
  enableAttempted = true;
  try {
    applyBuiltInProxy(decision.proxyEnv, runtime);
    enabled = true;
  } catch (error) {
    // Only Node's own proxy-configuration refusal is a configuration problem;
    // its message echoes the value, so none of it is kept.
    if ((error as { code?: unknown } | null)?.code !== "ERR_PROXY_INVALID_CONFIG") throw error;
    enableFailure = new OutboundProxyRefusal(
      "invalid",
      `Node refused the proxy configuration (${OUTBOUND_PROXY_INVALID_CODE}). Nothing was sent.`,
    );
  }
  return decision;
}

/**
 * The agent library bundles its own undici, which installs a plain global
 * dispatcher over Node's the first time it loads; a module loaded after
 * `ensureBuiltInProxy` would silently send direct. Put the proxy back.
 */
function reassertBuiltInProxy(): void {
  if (installed && currentDispatcher() !== installed.dispatcher) {
    applyBuiltInProxy(installed.proxyEnv, installed.runtime);
  }
}

export type ProxySupport = "enabled" | "started-with-node-flag" | "available" | "unsupported";

export function proxySupport(runtime: ProxyRuntime = liveRuntime()): ProxySupport {
  if (enabled) return "enabled";
  if (startedWithProxySupport(runtime)) return "started-with-node-flag";
  return runtime.setGlobalProxyFromEnv ? "available" : "unsupported";
}

/**
 * Node's fetch `NO_PROXY` rule: entries split on commas or whitespace, an
 * optional `:port`, a leading `.` or `*.` ignored, and a match on the host or
 * any subdomain of it; the single value `*` bypasses every host.
 */
export function isBypassedByNoProxy(url: URL, noProxy: string): boolean {
  if (noProxy === "*") return true;
  const host = url.host.replace(/:\d*$/u, "").toLowerCase();
  const port =
    Number.parseInt(url.port, 10) || DEFAULT_PORTS[url.protocol as "http:" | "https:"] || 0;
  for (const entry of noProxy.split(/[,\s]/u)) {
    if (!entry) continue;
    const parsed = /^(.+):(\d+)$/u.exec(entry);
    const name = (parsed ? parsed[1]! : entry).replace(/^\*?\./u, "").toLowerCase();
    const entryPort = parsed ? Number.parseInt(parsed[2]!, 10) : 0;
    if (entryPort && entryPort !== port) continue;
    if (host === name || host.endsWith(`.${name}`)) return true;
  }
  return false;
}

function requestUrlOf(input: Parameters<typeof globalThis.fetch>[0]): URL | undefined {
  try {
    return new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
  } catch {
    return undefined;
  }
}

function refusalFor(
  url: URL,
  scheme: SchemeProxy,
  issues: readonly OutboundProxyIssue[],
  runtime: ProxyRuntime,
): OutboundProxyRefusal | undefined {
  const label = url.protocol === "https:" ? "HTTPS" : "HTTP";
  if (scheme.state === "invalid") {
    const issue = issues.find((item) => item.variable === scheme.variable);
    return new OutboundProxyRefusal(
      "invalid",
      `Refused an outbound ${label} request because ${scheme.variable} ${issue?.problem ?? "is not usable"} (${OUTBOUND_PROXY_INVALID_CODE}). Nothing was sent.`,
      scheme.variable ?? undefined,
    );
  }
  if (enableFailure) return enableFailure;
  const support = proxySupport(runtime);
  if (support === "enabled" || support === "started-with-node-flag") return undefined;
  return new OutboundProxyRefusal(
    "not-enabled",
    support === "unsupported"
      ? `Refused an outbound ${label} request because ${scheme.variable} is set but this Node.js release has no built-in proxy support (${OUTBOUND_PROXY_NOT_ENABLED_CODE}). Nothing was sent.`
      : `Refused an outbound ${label} request because ${scheme.variable} is set but proxy support is not turned on in this process (${OUTBOUND_PROXY_NOT_ENABLED_CODE}). Nothing was sent.`,
    scheme.variable ?? undefined,
  );
}

/** Test seam for `outboundFetch`; production callers pass nothing. */
export interface OutboundFetchSeam {
  readonly env?: NodeJS.ProcessEnv;
  readonly runtime?: ProxyRuntime;
  /** Sees a proxied request's raw transport error before it is classified. */
  readonly onProxiedFailure?: (error: unknown) => void;
}

/**
 * The refusal for a proxied request the proxy did not carry. Only the
 * redacted `scheme://host:port` form of the proxy is shown.
 */
function proxyFailureRefusal(
  failure: ProxyFailure,
  url: URL,
  scheme: SchemeProxy,
): OutboundProxyRefusal {
  const label = url.protocol === "https:" ? "HTTPS" : "HTTP";
  // The proxy is named by its variable; doctor shows its redacted address.
  const proxy = `${scheme.variable} proxy`;
  const outcome = `(${REFUSAL_KINDS[failure.kind].code}). Nothing was sent to ${url.hostname}.`;
  const message =
    failure.kind === "unreachable"
      ? `Could not connect to the ${proxy} for an outbound ${label} request: ${failure.observed} ${outcome}`
      : failure.kind === "denied"
        ? `The ${proxy} refused to open a tunnel to ${url.hostname} with ${failure.observed} ${outcome}`
        : `The ${proxy} asked for proxy authentication with ${failure.observed} before opening a tunnel to ${url.hostname} ${outcome}`;
  return new OutboundProxyRefusal(failure.kind, message, scheme.variable ?? undefined);
}

/**
 * DocsFab's default fetch. Callers write `injected ?? outboundFetch()`, so an
 * injected fetch is never wrapped. It fails closed before any byte is sent when
 * a proxy setting applies to the request but is invalid or not turned on, and
 * while a proxy applies it sends loopback targets direct through transports
 * that connect only to loopback addresses, so neither the proxy nor a
 * `localhost` that resolves elsewhere sees them. A proxied request the proxy
 * could not carry fails with the refusal that names why.
 */
export function outboundFetch(seam: OutboundFetchSeam = {}): typeof globalThis.fetch {
  let loopbackHttp: typeof globalThis.fetch | undefined;
  let loopbackHttps: typeof globalThis.fetch | undefined;
  return async (input, init) => {
    const url = requestUrlOf(input);
    let proxied: SchemeProxy | undefined;
    if (url && (url.protocol === "http:" || url.protocol === "https:")) {
      const env = seam.env ?? process.env;
      const resolution = resolveOutboundProxy(env);
      const scheme = url.protocol === "https:" ? resolution.https : resolution.http;
      if (scheme.state !== "none") {
        if (isLoopbackHostname(url.hostname)) {
          const send =
            url.protocol === "https:"
              ? (loopbackHttps ??= createLoopbackHttpsFetch())
              : (loopbackHttp ??= createLoopbackHttpFetch());
          return send(input, init);
        }
        if (!resolution.noProxy || !isBypassedByNoProxy(url, resolution.noProxy.value)) {
          const refusal = refusalFor(url, scheme, resolution.issues, seam.runtime ?? liveRuntime());
          if (refusal) throw refusal;
          proxied = scheme;
        }
      }
    }
    reassertBuiltInProxy();
    if (!url || !proxied?.proxy) return globalThis.fetch(input, init);
    try {
      return await globalThis.fetch(input, init);
    } catch (error) {
      // Handles only a request this resolver sent through a proxy; loopback,
      // NO_PROXY and unproxied requests returned above and are never coded.
      seam.onProxiedFailure?.(error);
      const failure = classifyProxyFailure(error, new URL(proxied.proxy));
      if (!failure) throw error;
      throw proxyFailureRefusal(failure, url, proxied);
    }
  };
}

export interface OutboundProxyReport {
  readonly http: SchemeProxy;
  readonly https: SchemeProxy & { readonly inheritedFromHttp: boolean };
  readonly noProxy: OutboundProxyResolution["noProxy"];
  readonly support: ProxySupport;
  readonly issues: readonly OutboundProxyIssue[];
  readonly notices: readonly string[];
}

/** Doctor's offline view: no connection is made to the proxy or any target. */
export function inspectOutboundProxy(
  env: NodeJS.ProcessEnv = process.env,
  runtime: ProxyRuntime = liveRuntime(),
): OutboundProxyReport {
  const resolution = resolveOutboundProxy(env);
  return {
    http: resolution.http,
    https: resolution.https,
    noProxy: resolution.noProxy,
    support: proxySupport(runtime),
    issues: resolution.issues,
    notices: resolution.notices,
  };
}

function schemeLine(name: string, scheme: OutboundProxyReport["https"] | SchemeProxy): string {
  if (scheme.state === "none") return `${name}: none`;
  if (scheme.state === "invalid") return `${name}: refused (${scheme.variable})`;
  const inherited =
    "inheritedFromHttp" in scheme && scheme.inheritedFromHttp ? ", inherited from http" : "";
  return `${name}: ${scheme.proxy} (from ${scheme.variable}${inherited})`;
}

const SUPPORT_TEXT: Readonly<Record<ProxySupport, string>> = {
  enabled: "on (turned on by DocsFab)",
  "started-with-node-flag": "on (Node started with proxy support)",
  available: "available; each docsfab command turns it on when a proxy variable is set",
  unsupported: "unsupported by this Node.js release",
};

export function formatOutboundProxy(report: OutboundProxyReport): string[] {
  return [
    "Outbound proxy:",
    `  ${schemeLine("http", report.http)}`,
    `  ${schemeLine("https", report.https)}`,
    `  NO_PROXY: ${report.noProxy ? `${report.noProxy.value} (from ${report.noProxy.variable})` : "none"}`,
    `  Built-in proxy support: ${SUPPORT_TEXT[report.support]}`,
    ...report.notices.map((notice) => `  Note: ${notice}`),
  ];
}

/** Test seam: forget the per-process enable state. */
export function resetOutboundProxyStateForTests(): void {
  installed = undefined;
  enabled = false;
  enableAttempted = false;
  enableFailure = undefined;
}
