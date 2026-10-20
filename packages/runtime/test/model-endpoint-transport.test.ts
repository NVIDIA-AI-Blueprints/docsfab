// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfig, type DocsFabConfig } from "../src/config/runtime-loader.js";
import { checkLiveModel, diagnose } from "../src/doctor.js";
import { parseModelEndpoint } from "../src/model/configuration.js";
import {
  INSECURE_MODEL_ENDPOINT_CODE,
  INSECURE_MODEL_ENDPOINT_NEXT_ACTION,
  InsecureModelEndpointError,
  isAdmittedModelEndpoint,
  localhostResolvesToLoopback,
} from "../src/model/endpoint-transport.js";
import { resolveOperatorExecutionBinding } from "../src/model/operator-execution-binding.js";
import {
  createProviderBoundaryFetch,
  createProviderConnectionFactory,
} from "../src/model/provider.js";
import { DEFAULT_NEXT_ACTIONS, toOperatorErrorEnvelope } from "../src/operator/error-envelope.js";
import { runSetupBootstrap } from "../src/setup/bootstrap.js";
import { normalizeSetupEndpointUrl } from "../src/setup/split-layout-presets.js";
import { validModelEnvironment } from "./helpers.js";
import { temporaryRoots } from "./helpers/temp.js";

const roots = temporaryRoots();

const ADMITTED = [
  "http://localhost:8000/v1",
  "http://LOCALHOST:8000/v1",
  "http://127.0.0.1:8000/v1",
  "http://127.1:8000/v1",
  "http://127.10.20.30/v1",
  "http://[::1]:8000/v1",
  "http://[0:0:0:0:0:0:0:1]:8000/v1",
  "https://models.example.test/v1",
  "https://localhost:8443/v1",
] as const;

const REFUSED_PLAIN_HTTP = [
  "http://example.com/v1",
  "http://10.0.0.1:8000/v1",
  "http://0.0.0.0:8000/v1",
  "http://128.0.0.1:8000/v1",
  "http://localhost.evil.com:8000/v1",
  "http://localhost.:8000/v1",
  "http://127.0.0.1.nip.io:8000/v1",
  "http://evil-127.0.0.1.example/v1",
  "http://[::ffff:127.0.0.1]:8000/v1",
  "http://[::2]:8000/v1",
  "http://localhost:8000@evil.com/v1",
  "http://127.0.0.1@example.com/v1",
  "http://user:secret@localhost:8000/v1",
  "http://user@127.0.0.1:8000/v1",
] as const;

const neverCalled = () => vi.fn(async () => new Response(null, { status: 204 }));

describe("model endpoint transport rule", () => {
  it.each(ADMITTED)("admits %s", (url) => {
    expect(isAdmittedModelEndpoint(new URL(url))).toBe(true);
  });

  it.each([
    ...REFUSED_PLAIN_HTTP,
    "ftp://localhost/v1",
    "ws://127.0.0.1:8000/v1",
    "file:///tmp/v1",
  ])("refuses %s", (url) => {
    expect(isAdmittedModelEndpoint(new URL(url))).toBe(false);
  });

  it("keeps the situation catalog next action equal to the error's next action", () => {
    expect(DEFAULT_NEXT_ACTIONS[INSECURE_MODEL_ENDPOINT_CODE]).toBe(
      INSECURE_MODEL_ENDPOINT_NEXT_ACTION,
    );
    const envelope = toOperatorErrorEnvelope(
      InsecureModelEndpointError.remoteHost("MODEL_BASE_URL"),
    );
    expect(envelope).toMatchObject({
      code: INSECURE_MODEL_ENDPOINT_CODE,
      nextAction: INSECURE_MODEL_ENDPOINT_NEXT_ACTION,
      docsAnchor: "docs/configure/model.md",
      failure: { class: "operator-input" },
    });
  });

  it.each([
    [["127.0.0.1"], true],
    [["::1", "127.0.0.1"], true],
    [["127.0.0.1", "203.0.113.7"], false],
    [["::ffff:127.0.0.1"], false],
    [[], false],
  ] as const)("judges localhost resolving to %j as loopback=%s", async (addresses, loopback) => {
    await expect(localhostResolvesToLoopback(async () => addresses)).resolves.toBe(loopback);
  });

  it("fails closed when localhost does not resolve", async () => {
    await expect(
      localhostResolvesToLoopback(async () => {
        throw new Error("ENOTFOUND localhost");
      }),
    ).resolves.toBe(false);
  });
});

describe("provider boundary fetch on loopback plain HTTP", () => {
  it.each(["http://localhost:8000/v1", "http://127.0.0.1:8000/v1", "http://[::1]:8000/v1"])(
    "forwards a credential-bearing request to %s with manual redirects",
    async (baseUrl) => {
      const delegate = vi.fn(async () => new Response(null, { status: 204 }));
      const boundaryFetch = createProviderBoundaryFetch(
        baseUrl,
        delegate as typeof globalThis.fetch,
      );
      const target = `${baseUrl}/chat/completions`;

      await boundaryFetch(target, {
        method: "POST",
        headers: { authorization: "Bearer local-placeholder" },
        redirect: "follow",
      });

      expect(delegate).toHaveBeenCalledWith(
        target,
        expect.objectContaining({
          headers: { authorization: "Bearer local-placeholder" },
          redirect: "manual",
        }),
      );
    },
  );

  it.each(REFUSED_PLAIN_HTTP)(
    "refuses a configured %s base before I/O and names the code and next action",
    (baseUrl) => {
      const delegate = neverCalled();
      let failure: unknown;
      try {
        createProviderBoundaryFetch(baseUrl, delegate as typeof globalThis.fetch);
      } catch (error) {
        failure = error;
      }
      expect(String(failure)).toContain(INSECURE_MODEL_ENDPOINT_CODE);
      expect(String(failure)).toContain(INSECURE_MODEL_ENDPOINT_NEXT_ACTION);
      expect(delegate).not.toHaveBeenCalled();
    },
  );

  it.each([
    "http://127.0.0.1:8001/v1/chat/completions",
    "https://127.0.0.1:8000/v1/chat/completions",
    "http://localhost:8000/v1/chat/completions",
    "http://[::1]:8000/v1/chat/completions",
    "http://example.com/v1/chat/completions",
    "http://user:secret@127.0.0.1:8000/v1/chat/completions",
  ])("refuses a request from a 127.0.0.1:8000 base to %s before I/O", async (target) => {
    const delegate = neverCalled();
    const boundaryFetch = createProviderBoundaryFetch(
      "http://127.0.0.1:8000/v1",
      delegate as typeof globalThis.fetch,
    );

    await expect(boundaryFetch(target)).rejects.toThrow(
      "Provider request rejected by the configured origin boundary.",
    );
    expect(delegate).not.toHaveBeenCalled();
  });

  it.each([
    "https://foreign.example.test/v1/chat/completions",
    "http://127.0.0.1:9000/v1/chat/completions",
  ])("refuses a loopback redirect to %s without following it", async (location) => {
    const delegate = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(null, { status: 307, headers: { location } }),
    );
    const boundaryFetch = createProviderBoundaryFetch(
      "http://localhost:8000/v1",
      delegate as typeof globalThis.fetch,
    );

    await expect(boundaryFetch("http://localhost:8000/v1/chat/completions")).rejects.toThrow(
      "Provider response rejected because redirects are not allowed.",
    );
    expect(delegate).toHaveBeenCalledTimes(1);
    expect(delegate.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
  });
});

describe("setup and configuration admit plain HTTP only on loopback", () => {
  it.each(["http://localhost:8000/v1", "http://127.0.0.1:8000/v1", "http://[::1]:8000/v1"])(
    "normalizes the setup endpoint %s",
    (url) => {
      expect(normalizeSetupEndpointUrl(`${url}/`)).toBe(url);
    },
  );

  it.each(REFUSED_PLAIN_HTTP.filter((url) => !new URL(url).username))(
    "refuses setup of %s with the transport code before any write",
    async (baseUrl) => {
      const root = await roots.create("docsfab-loopback-setup-");
      await expect(
        runSetupBootstrap({
          model: { provider: "openai-compatible", modelId: "local-model", baseUrl },
          environment: { DOCSFAB_CONFIG_ROOT: root, COMPATIBLE_API_KEY: "test-placeholder" },
        }),
      ).rejects.toMatchObject({
        code: INSECURE_MODEL_ENDPOINT_CODE,
        message: expect.stringContaining("not loopback"),
      });
      expect(await readdir(root)).toEqual([]);
    },
  );

  it.each(["http://10.0.0.1:8000/v1", "http://localhost.evil.com/v1"])(
    "refuses a configured MODEL_BASE_URL of %s at load with the transport code",
    (baseUrl) => {
      expect(() =>
        parseModelEndpoint({ ...validModelEnvironment, MODEL_BASE_URL: baseUrl }),
      ).toThrowError(expect.objectContaining({ code: INSECURE_MODEL_ENDPOINT_CODE }));
    },
  );

  it("loads a configured loopback MODEL_BASE_URL", () => {
    expect(
      parseModelEndpoint({ ...validModelEnvironment, MODEL_BASE_URL: "http://127.0.0.1:8000/v1/" })
        .baseUrl,
    ).toBe("http://127.0.0.1:8000/v1");
  });
});

interface RecordedRequest {
  method: string | undefined;
  url: string | undefined;
  authorization: string | undefined;
  body: string;
}

/** A local OpenAI-compatible chat server, as a self-hosted NIM container exposes. */
async function startLocalModelServer(
  modelId: string,
  respond?: (request: IncomingMessage) => { status: number; headers: Record<string, string> },
): Promise<{ server: Server; port: number; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        body,
      });
      const override = respond?.(request);
      if (override) {
        response.writeHead(override.status, override.headers);
        response.end();
        return;
      }
      // Answer the endpoint compatibility requests as a tool-calling server would.
      const parsed = JSON.parse(body) as { tools?: unknown[]; messages?: { content?: unknown }[] };
      const asksForJson = JSON.stringify(parsed.messages ?? []).includes("only this JSON object");
      const delta =
        (parsed.tools?.length ?? 0) > 0
          ? {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call-local",
                  type: "function",
                  function: { name: "record_probe_result", arguments: '{"result":"ok"}' },
                },
              ],
            }
          : {
              role: "assistant",
              content: asksForJson
                ? '{"result":"ok","checks":["tool-calls","structured-output"]}'
                : "DOCSFAB_OK",
            };
      const chunks = [
        {
          id: "local-chat",
          object: "chat.completion.chunk",
          created: 1,
          model: modelId,
          choices: [{ index: 0, delta }],
        },
        {
          id: "local-chat",
          object: "chat.completion.chunk",
          created: 1,
          model: modelId,
          choices: [
            { index: 0, delta: {}, finish_reason: "tool_calls" in delta ? "tool_calls" : "stop" },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        },
      ];
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        [...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`), "data: [DONE]\n\n"].join(
          "",
        ),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as AddressInfo).port, requests };
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

const DOCTOR_ASSETS = {
  projectRoot: process.cwd(),
  skillCrateDirectory: new URL("../skill-crate", import.meta.url).pathname,
  qualityDirectory: new URL("../quality", import.meta.url).pathname,
  qualityPackDirectory: new URL("../quality-pack", import.meta.url).pathname,
} as const;

describe("self-hosted loopback endpoint journey", () => {
  it.each(["127.0.0.1", "localhost"])(
    "sets up http://%s, passes doctor, and reaches the local server with the credential",
    async (host) => {
      const modelId = "meta/llama-3.1-8b-instruct";
      const local = await startLocalModelServer(modelId);
      servers.push(local.server);
      const baseUrl = `http://${host}:${String(local.port)}/v1`;
      const root = await roots.create("docsfab-loopback-journey-");
      const secret = "local-nim-placeholder";

      const result = await runSetupBootstrap({
        model: {
          provider: "openai-compatible",
          transport: "openai-chat-completions",
          modelId,
          baseUrl,
        },
        environment: { DOCSFAB_CONFIG_ROOT: root, COMPATIBLE_API_KEY: secret },
      });
      expect(result.status).toBe("ready");
      expect(result.profile?.requestUrl).toBe(`${baseUrl}/chat/completions`);

      const loaded = loadConfig({ DOCSFAB_CONFIG_ROOT: root });
      expect(loaded.model.baseUrl).toBe(baseUrl);
      const config: DocsFabConfig = { ...loaded, ...DOCTOR_ASSETS };
      await expect(diagnose(config)).resolves.toMatchObject({ endpoint: baseUrl });
      expect(local.requests).toHaveLength(0);

      await expect(checkLiveModel(config)).resolves.toMatchObject({
        latencyMs: expect.any(Number),
        compatibility: { verdict: "compatible" },
      });
      // Two endpoint compatibility requests, then the connectivity turn.
      expect(local.requests).toHaveLength(3);

      const bound = await resolveOperatorExecutionBinding({ model: loaded.model, environment: {} });
      const connection = await createProviderConnectionFactory({
        routeId: bound.profile.routeId,
        transport: "openai-chat-completions",
      }).create(bound);
      const turn = await connection.runtime
        .streamSimple(connection.model, {
          systemPrompt: "Review the supplied document.",
          messages: [{ role: "user", content: "Reply with DOCSFAB_OK.", timestamp: 1 }],
        })
        .result();
      expect(turn.stopReason, turn.errorMessage).toBe("stop");

      expect(local.requests).toHaveLength(4);
      for (const request of local.requests) {
        expect(request).toMatchObject({
          method: "POST",
          url: "/v1/chat/completions",
          authorization: `Bearer ${secret}`,
        });
        expect(request.body).not.toContain(secret);
      }
    },
  );

  it("refuses a real loopback server's redirect to another loopback port without contacting it", async () => {
    const target = await startLocalModelServer("local-model");
    servers.push(target.server);
    const location = `http://127.0.0.1:${String(target.port)}/v1/chat/completions`;
    const redirecting = await startLocalModelServer("local-model", () => ({
      status: 307,
      headers: { location },
    }));
    servers.push(redirecting.server);
    const baseUrl = `http://127.0.0.1:${String(redirecting.port)}/v1`;
    const boundaryFetch = createProviderBoundaryFetch(baseUrl);

    await expect(
      boundaryFetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { authorization: "Bearer local-placeholder" },
        body: "{}",
      }),
    ).rejects.toThrow("Provider response rejected because redirects are not allowed.");
    expect(redirecting.requests).toHaveLength(1);
    expect(target.requests).toHaveLength(0);
  });
});
