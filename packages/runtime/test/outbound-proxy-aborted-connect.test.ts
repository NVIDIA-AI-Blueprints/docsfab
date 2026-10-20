// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { temporaryRoots } from "./helpers/temp.js";
import { nestedDeadlineMs, testTimeoutMs } from "./helpers/test-timeouts.js";
import {
  childEnvironment,
  RUNTIME_ROOT,
  runGuardedNode,
  startProxyFixture,
} from "./support/outbound-proxy-fixture.js";

// Local budgets in ms for one tsx-compiled child; in CI each case gets at
// least test.ciTimeoutMs.
const localCaseMs = 90_000;
const localProcessMs = 60_000;
const processDeadline = () => nestedDeadlineMs(localProcessMs, localCaseMs);
// Execution plumbing, not a product bound: when the caller, or the request's
// own timeout signal, ends a CONNECT the proxy never answers.
const ABORT_AFTER_MS = 300;

const roots = temporaryRoots();
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

const OWN_PREFIXES = ["docsfab-proxy-aborted-"];
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

const source = (path: string) => JSON.stringify(pathToFileURL(join(RUNTIME_ROOT, path)).href);
const TARGET = "https://models.example.test/v1/models";

/**
 * In order: a completed request on a dispatcher the child then closes (the
 * counter's positive control), two CONNECTs the proxy never answers that the
 * caller and a timeout signal end, and a last request that reaches the target.
 * The fixture snapshots its client-close count as each target request
 * arrives, so the last one reads it after both aborts settled, while the child
 * still holds every socket it did not close.
 */
const CHILD = `
const policy = await import(${source("src/model/outbound-http-policy.ts")});
policy.ensureBuiltInProxy();
const send = policy.outboundFetch();
const target = ${JSON.stringify(TARGET)};
const abortAfterMs = Number(process.env.ABORT_AFTER_MS);
const results = {};

const NodeProxyAgent = globalThis[Symbol.for("undici.globalDispatcher.1")].constructor;
const own = new NodeProxyAgent({ httpsProxy: process.env.HTTPS_PROXY });
const first = await send(target, { dispatcher: own });
await first.arrayBuffer();
await own.close();
results.control = { status: first.status, dispatcher: NodeProxyAgent.name };

// Each signal starts only when its own request does.
const signals = {
  caller: () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), abortAfterMs);
    return controller.signal;
  },
  timeout: () => AbortSignal.timeout(abortAfterMs),
};
for (const [id, signalFor] of Object.entries(signals)) {
  try {
    await send(target, { signal: signalFor() });
    results[id] = null;
  } catch (error) {
    results[id] = { name: error?.name ?? null };
  }
}

const last = await send(target);
await last.arrayBuffer();
results.barrier = { status: last.status };
process.stdout.write(JSON.stringify(results), () => process.exit(0));
`;

describe("aborted CONNECTs on Node's fetch", { timeout: testTimeoutMs(localCaseMs) }, () => {
  it("keeps the client socket of a CONNECT the caller or a timeout ended open, while a closed dispatcher's socket closes", async () => {
    const fixture = await startProxyFixture(roots, closers, "docsfab-proxy-aborted-");
    fixture.script([
      { kind: "tunnel" },
      { kind: "silent" },
      { kind: "silent" },
      { kind: "tunnel" },
    ]);
    const directory = await roots.create("docsfab-proxy-aborted-child-");
    const script = join(directory, "child.mts");
    await writeFile(script, CHILD);
    const result = await runGuardedNode(
      fixture,
      ["--import", "tsx", script],
      childEnvironment(fixture, {
        HTTPS_PROXY: fixture.proxyUrl,
        ABORT_AFTER_MS: String(ABORT_AFTER_MS),
      }),
      processDeadline(),
    );
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      control: { status: 404, dispatcher: "EnvHttpProxyAgent" },
      caller: { name: "AbortError" },
      timeout: { name: "TimeoutError" },
      barrier: { status: 404 },
    });
    expect(fixture.proxyLog.map((entry) => entry.line)).toEqual(
      Array<string>(4).fill("CONNECT models.example.test:443 HTTP/1.1"),
    );
    expect(fixture.proxyConnections()).toBe(4);
    expect(fixture.targetRequests.map((request) => request.url)).toEqual([
      "/v1/models",
      "/v1/models",
    ]);
    // Positive control, then the measurement: by the time the last request
    // reached the target, the closed dispatcher's socket had closed (1) and
    // neither aborted CONNECT's socket had.
    expect(fixture.peerClosuresAtTargetRequest).toEqual([0, 1]);
  });
});
