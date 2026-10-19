// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { LookupAddress, LookupAllOptions, LookupOneOptions } from "node:dns";
import { Agent, request as httpRequest, type IncomingMessage } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { Readable } from "node:stream";

import {
  isLoopbackAddress,
  resolveHostAddresses,
  type HostResolver,
} from "./endpoint-transport.js";

/**
 * The loopback transport refused to connect because the host name resolved
 * to an address outside 127.0.0.0/8 and `::1`. Nothing was sent.
 */
export class LoopbackResolutionRefusal extends Error {
  public constructor() {
    super("Refused a plain-HTTP model connection whose host did not resolve only to loopback.");
    this.name = "LoopbackResolutionRefusal";
  }
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/** A `net.connect` lookup that answers only when every address is loopback. */
function loopbackOnlyLookup(resolver: HostResolver) {
  return (
    hostname: string,
    options: LookupOneOptions | LookupAllOptions,
    callback: LookupCallback,
  ): void => {
    resolver(hostname).then(
      (addresses) => {
        if (addresses.length === 0 || !addresses.every(isLoopbackAddress)) {
          callback(new LoopbackResolutionRefusal(), []);
          return;
        }
        const entries = addresses.map((address) => ({
          address,
          family: address.includes(":") ? 6 : 4,
        }));
        if (options.all) callback(null, entries);
        else callback(null, entries[0]!.address, entries[0]!.family);
      },
      (error: unknown) => callback(error as NodeJS.ErrnoException, []),
    );
  };
}

function responseHeaders(incoming: IncomingMessage): Headers {
  const headers = new Headers();
  const raw = incoming.rawHeaders;
  for (let index = 0; index + 1 < raw.length; index += 2) {
    headers.append(raw[index]!, raw[index + 1]!);
  }
  return headers;
}

/**
 * A fetch for plain-HTTP loopback model endpoints. It uses its own
 * `http.Agent`, never the global agent or dispatcher, so `HTTP_PROXY` and
 * `NODE_USE_ENV_PROXY` cannot route the request (and its credential) through a
 * proxy in cleartext. Every connection resolves its host through a lookup that
 * admits only loopback addresses, so a name cannot rebind between a check and
 * the connect. Responses are not decompressed; the request asks for identity.
 */
export function createLoopbackHttpFetch(
  resolver: HostResolver = resolveHostAddresses,
): typeof globalThis.fetch {
  return createLoopbackFetch("http:", resolver);
}

/**
 * The HTTPS sibling of {@link createLoopbackHttpFetch}: its own `https.Agent`
 * (Node applies the built-in proxy only to agents built with `proxyEnv`) and
 * the same loopback-only lookup, so an https request to this machine never
 * reaches a proxy and a `localhost` that resolves elsewhere is refused.
 */
export function createLoopbackHttpsFetch(
  resolver: HostResolver = resolveHostAddresses,
): typeof globalThis.fetch {
  return createLoopbackFetch("https:", resolver);
}

function createLoopbackFetch(
  protocol: "http:" | "https:",
  resolver: HostResolver,
): typeof globalThis.fetch {
  const agent = protocol === "http:" ? new Agent() : new HttpsAgent();
  const send = protocol === "http:" ? httpRequest : httpsRequest;
  const lookup = loopbackOnlyLookup(resolver);
  return async (input, init) => {
    const streamingBody = init?.body instanceof ReadableStream;
    const request = new Request(
      input,
      streamingBody ? ({ ...init, duplex: "half" } as RequestInit) : init,
    );
    const url = new URL(request.url);
    if (url.protocol !== protocol) {
      throw new TypeError(
        protocol === "http:"
          ? "The loopback model transport sends only plain-HTTP requests to this machine."
          : "The loopback HTTPS transport sends only HTTPS requests to this machine.",
      );
    }
    const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
    const headers: Record<string, string> = {};
    request.headers.forEach((value, name) => {
      headers[name] = value;
    });
    headers["accept-encoding"] = "identity";
    if (body) headers["content-length"] = String(body.byteLength);

    return new Promise<Response>((resolve, reject) => {
      const outgoing = send(
        {
          hostname: url.hostname.replace(/^\[(.*)\]$/u, "$1"),
          ...(url.port ? { port: url.port } : {}),
          path: `${url.pathname}${url.search}`,
          method: request.method,
          headers,
          agent,
          lookup: lookup as never,
          signal: request.signal,
        },
        (incoming) => {
          const status = incoming.statusCode ?? 0;
          const nullBody =
            request.method === "HEAD" || status === 204 || status === 205 || status === 304;
          try {
            resolve(
              new Response(
                nullBody ? null : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>),
                {
                  status,
                  statusText: incoming.statusMessage ?? "",
                  headers: responseHeaders(incoming),
                },
              ),
            );
            if (nullBody) incoming.resume();
          } catch (error) {
            incoming.destroy();
            reject(error);
          }
        },
      );
      outgoing.on("error", reject);
      outgoing.end(body);
    });
  };
}
