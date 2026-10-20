// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DocsFabConfig } from "../src/config/runtime-loader.js";
import { checkLiveModel, diagnose } from "../src/doctor.js";
import { parseModelEndpoint } from "../src/model/configuration.js";
import {
  INSECURE_MODEL_ENDPOINT_CODE,
  INSECURE_MODEL_ENDPOINT_NEXT_ACTION,
} from "../src/model/endpoint-transport.js";
import { createModelConnection, createProviderBoundaryFetch } from "../src/model/provider.js";
import { toOperatorErrorEnvelope } from "../src/operator/error-envelope.js";
import { validModelEnvironment } from "./helpers.js";

// This host's resolver answers `localhost` with a non-loopback address, as a
// hosts file without the entry plus a hostile network resolver would.
vi.mock("node:dns/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns/promises")>();
  const lookup = async (hostname: string, options?: unknown) =>
    hostname === "localhost"
      ? [{ address: "203.0.113.7", family: 4 }]
      : (actual.lookup as (name: string, options?: unknown) => Promise<unknown>)(hostname, options);
  return { ...actual, default: { ...actual, lookup }, lookup };
});

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function startServer(): Promise<{ port: number; requests: () => number }> {
  let requests = 0;
  const server = createServer((request, response) => {
    requests += 1;
    request.resume();
    response.end();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  closers.push(
    () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  );
  return { port: (server.address() as AddressInfo).port, requests: () => requests };
}

function localhostModel(port: number) {
  return parseModelEndpoint({
    ...validModelEnvironment,
    MODEL_BASE_URL: `http://localhost:${String(port)}/v1`,
  });
}

describe("plain-HTTP localhost that does not resolve to loopback", () => {
  it("stops model connection creation with the transport code and next action", async () => {
    const server = await startServer();
    let failure: unknown;
    try {
      await createModelConnection(localhostModel(server.port));
    } catch (error) {
      failure = error;
    }
    expect(toOperatorErrorEnvelope(failure)).toMatchObject({
      code: INSECURE_MODEL_ENDPOINT_CODE,
      nextAction: INSECURE_MODEL_ENDPOINT_NEXT_ACTION,
      failure: { class: "operator-input" },
    });
    expect(server.requests()).toBe(0);
  });

  it("refuses the live compatibility probe before any request carries the credential", async () => {
    const server = await startServer();
    let failure: unknown;
    try {
      await checkLiveModel({
        projectRoot: process.cwd(),
        model: localhostModel(server.port),
      } as DocsFabConfig);
    } catch (error) {
      failure = error;
    }
    expect(server.requests()).toBe(0);
    expect(toOperatorErrorEnvelope(failure)).toMatchObject({
      code: INSECURE_MODEL_ENDPOINT_CODE,
      nextAction: INSECURE_MODEL_ENDPOINT_NEXT_ACTION,
    });
  });

  it("reports the coded stop from offline doctor", async () => {
    const server = await startServer();
    const config: DocsFabConfig = {
      projectRoot: process.cwd(),
      skillCrateDirectory: new URL("../skill-crate", import.meta.url).pathname,
      qualityDirectory: new URL("../quality", import.meta.url).pathname,
      qualityPackDirectory: new URL("../quality-pack", import.meta.url).pathname,
      stateDirectory: "/tmp/docsfab-test-runs",
      retryPolicy: {
        maxRetries: 1,
        baseDelayMs: 1_000,
        maxDelayMs: 4_000,
        retryableCategories: ["timeout", "throttled"],
      },
      model: localhostModel(server.port),
    };

    await expect(diagnose(config)).rejects.toMatchObject({ code: INSECURE_MODEL_ENDPOINT_CODE });
    expect(server.requests()).toBe(0);
  });

  it("refuses at connect time in the default loopback transport before sending", async () => {
    const server = await startServer();
    const baseUrl = `http://localhost:${String(server.port)}/v1`;

    await expect(
      createProviderBoundaryFetch(baseUrl)(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { authorization: "Bearer local-placeholder" },
        body: "{}",
      }),
    ).rejects.toThrow(`(${INSECURE_MODEL_ENDPOINT_CODE})`);
    expect(server.requests()).toBe(0);
  });
});
