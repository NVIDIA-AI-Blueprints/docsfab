// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import http, { createServer, type Server } from "node:http";
import {
  createServer as createNetServer,
  type AddressInfo,
  type Server as NetServer,
} from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createLoopbackHttpFetch,
  LoopbackResolutionRefusal,
} from "../src/model/loopback-http-fetch.js";
import { createProviderBoundaryFetch } from "../src/model/provider.js";
import { temporaryRoots } from "./helpers/temp.js";

const roots = temporaryRoots();
const RUNTIME_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

interface Received {
  method: string | undefined;
  url: string | undefined;
  authorization: string | undefined;
  acceptEncoding: string | undefined;
  body: string;
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function startServer(): Promise<{ port: number; received: Received[] }> {
  const received: Received[] = [];
  const server: Server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      received.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        acceptEncoding: request.headers["accept-encoding"],
        body,
      });
      if (request.url?.endsWith("/empty")) {
        response.writeHead(204, { "x-model": "local" });
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream", "x-model": "local" });
      response.write("data: first\n\n");
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  closers.push(
    () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  );
  return { port: (server.address() as AddressInfo).port, received };
}

/** Records the first request line of every connection and answers 502, as a hostile proxy would. */
async function startFakeProxy(): Promise<{ port: number; lines: string[] }> {
  const lines: string[] = [];
  const proxy: NetServer = createNetServer((socket) => {
    socket.once("data", (data: Buffer) => {
      lines.push(data.toString("latin1").split("\r\n")[0] ?? "");
      socket.end("HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
    });
    socket.on("error", () => undefined);
  });
  await new Promise<void>((done) => proxy.listen(0, "127.0.0.1", done));
  closers.push(() => new Promise<void>((done) => proxy.close(() => done())));
  return { port: (proxy.address() as AddressInfo).port, lines };
}

const PI_DISPATCHER = pathToFileURL(
  join(RUNTIME_ROOT, "node_modules/@earendil-works/pi-coding-agent/dist/core/http-dispatcher.js"),
).href;
const PROVIDER_MODULE = pathToFileURL(join(RUNTIME_ROOT, "src/model/provider.ts")).href;

/**
 * Child process: activate an environment proxy, send one request to the control
 * server through the global fetch, then one to the model server through the
 * provider boundary. The proxy log tells the two apart by port.
 */
const PROXY_CHILD = `
if (process.argv[2] === "pi-dispatcher") {
  (await import(${JSON.stringify(PI_DISPATCHER)})).configureHttpDispatcher();
}
const init = () => ({ method: "POST", headers: { authorization: "Bearer child-placeholder" }, body: "{}" });
const outcome = async (send) => {
  try {
    return { status: (await send()).status };
  } catch (error) {
    return { error: String(error) };
  }
};
const control = await outcome(() => fetch(process.env.CONTROL_URL, init()));
const { createProviderBoundaryFetch } = await import(${JSON.stringify(PROVIDER_MODULE)});
const target = process.env.TARGET_URL;
const boundary = await outcome(() =>
  createProviderBoundaryFetch(new URL("/v1", target).href)(target, init()),
);
console.log(JSON.stringify({ control, boundary }));
`;

describe("loopback plain-HTTP transport", () => {
  it("sends method, headers, and body and streams the response", async () => {
    const server = await startServer();
    const send = createLoopbackHttpFetch(async () => ["127.0.0.1"]);

    const response = await send(`http://localhost:${String(server.port)}/v1/chat/completions?x=1`, {
      method: "POST",
      headers: { authorization: "Bearer local-placeholder", "accept-encoding": "gzip" },
      body: '{"model":"local"}',
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-model")).toBe("local");
    expect(await response.text()).toBe("data: first\n\ndata: [DONE]\n\n");
    expect(server.received).toEqual([
      {
        method: "POST",
        url: "/v1/chat/completions?x=1",
        authorization: "Bearer local-placeholder",
        acceptEncoding: "identity",
        body: '{"model":"local"}',
      },
    ]);
  });

  it("returns a null body for a 204 response", async () => {
    const server = await startServer();
    const response = await createLoopbackHttpFetch()(
      `http://127.0.0.1:${String(server.port)}/empty`,
    );
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
  });

  it.each([
    [["203.0.113.7"]],
    [["127.0.0.1", "203.0.113.7"]],
    [["::ffff:127.0.0.1"]],
    [[]],
  ] as const)(
    "refuses to connect when localhost resolves to %j at connect time",
    async (addresses) => {
      const server = await startServer();
      const send = createLoopbackHttpFetch(async () => addresses);

      await expect(
        send(`http://localhost:${String(server.port)}/v1/chat/completions`, {
          method: "POST",
          headers: { authorization: "Bearer local-placeholder" },
          body: "{}",
        }),
      ).rejects.toBeInstanceOf(LoopbackResolutionRefusal);
      expect(server.received).toHaveLength(0);
    },
  );

  it("maps a connect-time refusal to a coded provider boundary refusal", async () => {
    const server = await startServer();
    const baseUrl = `http://localhost:${String(server.port)}/v1`;
    const boundaryFetch = createProviderBoundaryFetch(
      baseUrl,
      createLoopbackHttpFetch(async () => ["203.0.113.7"]),
    );

    await expect(boundaryFetch(`${baseUrl}/chat/completions`)).rejects.toThrow(
      "(model-endpoint-insecure-transport)",
    );
    expect(server.received).toHaveLength(0);
  });

  it("does not resolve a literal loopback address", async () => {
    const server = await startServer();
    const resolver = vi.fn(async () => ["203.0.113.7"]);

    const response = await createLoopbackHttpFetch(resolver)(
      `http://127.0.0.1:${String(server.port)}/v1/chat/completions`,
    );

    expect(response.status).toBe(200);
    expect(resolver).not.toHaveBeenCalled();
  });

  it("uses neither the global fetch nor the global HTTP agent for a plain-HTTP base", async () => {
    const server = await startServer();
    const globalFetch = vi.fn(async () => {
      throw new Error("global fetch must not carry loopback traffic");
    });
    vi.stubGlobal("fetch", globalFetch);
    const originalAgent = http.globalAgent;
    const globalAgentConnections = vi.fn(() => {
      throw new Error("global agent must not carry loopback traffic");
    });
    const trap = new http.Agent();
    (trap as unknown as { createConnection: () => never }).createConnection =
      globalAgentConnections;
    http.globalAgent = trap;
    try {
      const baseUrl = `http://127.0.0.1:${String(server.port)}/v1`;
      const response = await createProviderBoundaryFetch(baseUrl)(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { authorization: "Bearer local-placeholder" },
        body: "{}",
      });
      expect(response.status).toBe(200);
    } finally {
      http.globalAgent = originalAgent;
    }
    expect(globalFetch).not.toHaveBeenCalled();
    expect(globalAgentConnections).not.toHaveBeenCalled();
    expect(server.received).toHaveLength(1);
  });

  it.for([
    ["pi-dispatcher", "Pi's EnvHttpProxyAgent global dispatcher"],
    ["node-env", "NODE_USE_ENV_PROXY=1"],
  ] as const)(
    "sends nothing to an HTTP_PROXY activated by %s (%s)",
    async ([mode]) => {
      const server = await startServer();
      const control = await startServer();
      const proxy = await startFakeProxy();
      const root = await roots.create("docsfab-loopback-proxy-");
      const script = join(root, "send.mjs");
      await writeFile(script, PROXY_CHILD);
      const proxyUrl = `http://127.0.0.1:${String(proxy.port)}`;
      const environment: NodeJS.ProcessEnv = { ...process.env };
      for (const name of [
        "NO_PROXY",
        "no_proxy",
        "HTTPS_PROXY",
        "https_proxy",
        "ALL_PROXY",
        "all_proxy",
        "NODE_USE_ENV_PROXY",
      ]) {
        delete environment[name];
      }
      Object.assign(environment, {
        HTTP_PROXY: proxyUrl,
        http_proxy: proxyUrl,
        CONTROL_URL: `http://127.0.0.1:${String(control.port)}/control`,
        TARGET_URL: `http://127.0.0.1:${String(server.port)}/v1/chat/completions`,
        ...(mode === "node-env" ? { NODE_USE_ENV_PROXY: "1" } : {}),
      });
      const output = await new Promise<string>((done, fail) => {
        const child = spawn(process.execPath, ["--import", "tsx", script, mode], {
          cwd: RUNTIME_ROOT,
          env: environment,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
        });
        child.on("error", fail);
        child.on("close", () => done(stdout.trim()));
      });
      const result = JSON.parse(output) as { boundary: unknown; control: unknown };

      // Control: the global fetch in the same process went to the proxy.
      // Every Node DocsFab supports implements NODE_USE_ENV_PROXY, so an
      // unproxied control is a failure, not a skip.
      const controlProxied = proxy.lines.some((line) => line.includes(`:${String(control.port)}`));
      expect(controlProxied, JSON.stringify({ result, lines: proxy.lines })).toBe(true);
      expect(control.received).toHaveLength(0);

      expect(result.boundary).toEqual({ status: 200 });
      expect(proxy.lines.some((line) => line.includes(`:${String(server.port)}`))).toBe(false);
      expect(server.received).toHaveLength(1);
      expect(server.received[0]?.authorization).toBe("Bearer child-placeholder");
    },
    60_000,
  );
});
