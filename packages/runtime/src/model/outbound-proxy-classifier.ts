// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Names what an HTTP proxy did when a proxied request failed: it could not be
 * reached, or it answered the tunnel request with 403 or 407. Anything else
 * returns `undefined` and the caller rethrows the error unchanged.
 *
 * `outboundFetch` calls this only for a request the resolver sends through a
 * proxy, so the only TCP connection and name lookup the error can describe
 * are the proxy's own. The host and port checks below are defense in depth.
 * The policy module builds the refusal; this module imports nothing from it,
 * so the two do not import each other.
 */

export type ProxyFailureKind = "unreachable" | "denied" | "auth-required";

export interface ProxyFailure {
  readonly kind: ProxyFailureKind;
  /** An errno name or `HTTP <status>`; never text the proxy sent. */
  readonly observed: string;
}

/** A TCP connect to the proxy that failed before any byte was exchanged. */
const CONNECT_FAILURES = new Set(["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT"]);

/** A failed lookup, coded only when the name looked up is the proxy's. */
const LOOKUP_FAILURES = new Set(["ENOTFOUND", "EAI_AGAIN"]);

/**
 * Node's fetch reports a tunnel reply that is not 200 only in this message of
 * an `UND_ERR_ABORTED` error; no field carries the status. This is the one
 * exception to recognizing failures by type: the text is undici's own fixed
 * sentence about the proxy's CONNECT reply, never a provider body or a
 * response DocsFab received, and it is matched in full.
 */
const TUNNEL_REPLY = /^Proxy response \((\d{3})\) !== 200 when HTTP Tunneling$/u;

/** Tunnel replies that name an operator fix; every other status stays uncoded. */
const TUNNEL_REPLY_KINDS: Readonly<Record<string, ProxyFailureKind>> = {
  "403": "denied",
  "407": "auth-required",
};

/** Protocol default ports, for a proxy URL that names none. Not bounds. */
const DEFAULT_PORTS: Readonly<Record<string, number>> = {
  "http:": 80,
  "https:": 443,
};

export type ErrorFields = {
  readonly name?: unknown;
  readonly code?: unknown;
  readonly message?: unknown;
  readonly hostname?: unknown;
  readonly port?: unknown;
  readonly cause?: unknown;
  readonly errors?: unknown;
};

/** Every error in the `cause` chain and in `AggregateError.errors`, each once. */
export function failureMembers(error: unknown): ErrorFields[] {
  const members: ErrorFields[] = [];
  const seen = new Set<unknown>();
  const pending: unknown[] = [error];
  while (pending.length > 0) {
    const next = pending.shift();
    if (!next || typeof next !== "object" || seen.has(next)) continue;
    seen.add(next);
    const member = next as ErrorFields;
    members.push(member);
    pending.push(member.cause);
    if (Array.isArray(member.errors)) pending.push(...(member.errors as unknown[]));
  }
  return members;
}

function bareHost(hostname: string): string {
  return hostname.replace(/^\[(.*)\]$/u, "$1").toLowerCase();
}

/** The CONNECT status from undici's tunnel error, or undefined for any other error. */
function tunnelReplyStatus(member: ErrorFields): string | undefined {
  if (member.name !== "AbortError" || member.code !== "UND_ERR_ABORTED") return undefined;
  if (typeof member.message !== "string") return undefined;
  return TUNNEL_REPLY.exec(member.message)?.[1];
}

/**
 * Classify a failed request that went through `proxy`. A `ConnectTimeoutError`
 * and a headers timeout stay uncoded: a stalled proxy and a stalled target
 * behind a healthy tunnel produce the same error.
 */
export function classifyProxyFailure(error: unknown, proxy: URL): ProxyFailure | undefined {
  const proxyHost = bareHost(proxy.hostname);
  const proxyPort = Number(proxy.port) || DEFAULT_PORTS[proxy.protocol];
  for (const member of failureMembers(error)) {
    const status = tunnelReplyStatus(member);
    if (status !== undefined) {
      // The proxy answered, so it is reachable; only 403 and 407 name a fix.
      const kind = TUNNEL_REPLY_KINDS[status];
      return kind ? { kind, observed: `HTTP ${status}` } : undefined;
    }
    const code = member.code;
    if (typeof code !== "string") continue;
    // In a fetch error only a TCP connect carries a port with one of these
    // codes: bind and listen errors use other codes, and fetch opens no UDP socket.
    if (CONNECT_FAILURES.has(code) && member.port === proxyPort) {
      return { kind: "unreachable", observed: code };
    }
    if (
      LOOKUP_FAILURES.has(code) &&
      typeof member.hostname === "string" &&
      bareHost(member.hostname) === proxyHost
    ) {
      return { kind: "unreachable", observed: code };
    }
  }
  return undefined;
}
