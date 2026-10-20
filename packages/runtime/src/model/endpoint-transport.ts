// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { lookup } from "node:dns/promises";
import { isIPv4 } from "node:net";

/**
 * Model endpoint transport rule shared by setup, configuration loading, the
 * connection factory, and the provider boundary fetch: HTTPS for any host,
 * plain HTTP only for this machine.
 */

export const INSECURE_MODEL_ENDPOINT_CODE = "model-endpoint-insecure-transport" as const;

/** Same text as the `model-endpoint-insecure-transport` situation catalog row. */
export const INSECURE_MODEL_ENDPOINT_NEXT_ACTION =
  "Use an HTTPS endpoint URL, or, for a model server on this machine, use plain HTTP with the host localhost, 127.0.0.1, or [::1], then rerun docsfab setup.";

/** Shown when `localhost` does not resolve only to loopback addresses. */
export const LOCALHOST_RESOLUTION_MESSAGE =
  "The model endpoint uses plain HTTP to localhost, but localhost does not resolve only to loopback addresses on this host. DocsFab sends model requests and credentials over plain HTTP only to this machine.";

export class InsecureModelEndpointError extends Error {
  public readonly code = INSECURE_MODEL_ENDPOINT_CODE;
  public readonly nextAction = INSECURE_MODEL_ENDPOINT_NEXT_ACTION;

  public constructor(message: string) {
    super(message);
    this.name = "InsecureModelEndpointError";
  }

  public static remoteHost(field: string): InsecureModelEndpointError {
    return new InsecureModelEndpointError(
      `${field} uses plain HTTP to a host that is not loopback. DocsFab sends model requests and credentials over plain HTTP only to this machine.`,
    );
  }
}

/**
 * True for a WHATWG `URL.hostname` that names this machine: an IPv4 literal in
 * 127.0.0.0/8, the IPv6 literal `[::1]`, or exactly `localhost`. The URL parser
 * already lowercases names and canonicalizes IPv4 shorthand such as `127.1`.
 * Names that only contain a loopback label (`localhost.example`,
 * `127.0.0.1.nip.io`) resolve through remote DNS and are not loopback.
 */
export function isLoopbackHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  return isIPv4(hostname) && hostname.startsWith("127.");
}

/** True for a resolved socket address in 127.0.0.0/8 or `::1`. */
export function isLoopbackAddress(address: string): boolean {
  return address === "::1" || (isIPv4(address) && address.startsWith("127."));
}

/** HTTPS to any host, or plain HTTP to a loopback host with no userinfo. */
export function isAdmittedModelEndpoint(url: URL): boolean {
  if (url.protocol === "https:") return true;
  return (
    url.protocol === "http:" &&
    url.username === "" &&
    url.password === "" &&
    isLoopbackHostname(url.hostname)
  );
}

/** Refuse a parsed plain-HTTP endpoint to a host that is not loopback; other shapes pass. */
export function assertModelEndpointTransport(url: URL, field: string): void {
  if (url.protocol === "http:" && !isAdmittedModelEndpoint(url)) {
    throw InsecureModelEndpointError.remoteHost(field);
  }
}

/** Resolver seam returning every address for a name; production uses the host resolver. */
export type HostResolver = (hostname: string) => Promise<readonly string[]>;

export const resolveHostAddresses: HostResolver = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

/**
 * True when every address the resolver returns for `localhost` is loopback.
 * RFC 6761 reserves the name for loopback, but a host whose hosts file lacks
 * it can forward the query to network DNS, where another party chooses the
 * answer.
 */
export async function localhostResolvesToLoopback(
  resolver: HostResolver = resolveHostAddresses,
): Promise<boolean> {
  let addresses: readonly string[];
  try {
    addresses = await resolver("localhost");
  } catch {
    return false;
  }
  return addresses.length > 0 && addresses.every(isLoopbackAddress);
}

/**
 * Refuse, with the transport code, a plain-HTTP `localhost` endpoint on a host
 * where the name does not resolve only to loopback. This names the stop before
 * any request; the loopback transport's connect-time lookup enforces the same
 * rule on every connection.
 */
export async function assertLocalhostEndpointResolvesToLoopback(
  baseUrl: string,
  resolver: HostResolver = resolveHostAddresses,
): Promise<void> {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" || url.hostname !== "localhost") return;
  if (!(await localhostResolvesToLoopback(resolver))) {
    throw new InsecureModelEndpointError(LOCALHOST_RESOLUTION_MESSAGE);
  }
}
