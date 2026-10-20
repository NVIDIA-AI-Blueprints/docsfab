// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { isBypassedByNoProxy } from "../src/model/outbound-http-policy.js";
import { validModelEnvironment } from "./helpers.js";
import { temporaryRoots } from "./helpers/temp.js";
import { nestedDeadlineMs, testTimeoutMs } from "./helpers/test-timeouts.js";
import {
  childEnvironment,
  RUNTIME_ROOT,
  runGuardedNode,
  startProxyFixture,
  type ChildResult,
  type ProxyFixture,
} from "./support/outbound-proxy-fixture.js";

// Local budgets in ms for one tsx-compiled DocsFab child; in CI each case gets
// at least test.ciTimeoutMs and the child keeps its local share of it.
const localCaseMs = 90_000;
const localProcessMs = 60_000;
const processDeadline = () => nestedDeadlineMs(localProcessMs, localCaseMs);

const roots = temporaryRoots();
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

// Every directory these cases create, including the children's TMPDIR and
// HOME, lives under a fixture root that is removed after each case.
const OWN_PREFIXES = [
  "docsfab-proxy-fixture-",
  "docsfab-cli-link-",
  "docsfab-entry-link-",
  "docsfab-bypass-child-",
];
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

const CANARY = "CANARYPW";
const OPENAI_KEY = `sk-${"A".repeat(24)}`;

/** `profile inspect --catalog` on the OpenAI API route: one catalog GET to api.openai.com. */
const catalogEnvironment = {
  ...validModelEnvironment,
  MODEL_PROVIDER: "openai",
  MODEL_BASE_URL: "https://api.openai.com/v1",
  MODEL_ID: "gpt-5.4",
  MODEL_API_KEY: OPENAI_KEY,
};
const CATALOG = ["profile", "inspect", "--catalog"] as const;
const LAUNCHER = ["--import", "tsx", "src/launcher.ts"] as const;

function credentialedProxy(fixture: ProxyFixture): string {
  return `http://user:${CANARY}@127.0.0.1:${String(fixture.proxyPort)}`;
}

async function dnsAttempts(fixture: ProxyFixture): Promise<string[]> {
  return (await readFile(fixture.dnsLogPath, "utf8")).split("\n").filter(Boolean);
}

function expectNoCredential(result: ChildResult): void {
  for (const form of [CANARY, Buffer.from(`user:${CANARY}`).toString("base64")]) {
    expect(result.stdout).not.toContain(form);
    expect(result.stderr).not.toContain(form);
  }
}

async function expectCatalogThroughProxy(
  fixture: ProxyFixture,
  result: ChildResult,
): Promise<void> {
  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
  expect(fixture.proxyLog.map((entry) => entry.line)).toEqual([
    "CONNECT api.openai.com:443 HTTP/1.1",
  ]);
  expect(fixture.targetRequests).toEqual([
    { host: "api.openai.com", method: "GET", url: "/v1/models/gpt-5.4" },
  ]);
  expect(result.stdout).toContain("Inference catalog: unavailable (model-absent)");
  expect(await dnsAttempts(fixture)).toEqual([]);
}

describe("shipped entries turn on proxy support", { timeout: testTimeoutMs(localCaseMs) }, () => {
  it("launcher: catalog discovery goes through the proxy with its credential", async () => {
    const fixture = await startProxyFixture(roots, closers);
    const result = await runGuardedNode(
      fixture,
      [...LAUNCHER, ...CATALOG],
      childEnvironment(fixture, { ...catalogEnvironment, HTTPS_PROXY: credentialedProxy(fixture) }),
      processDeadline(),
    );
    await expectCatalogThroughProxy(fixture, result);
    expect(fixture.proxyLog[0]?.proxyAuthorization).toBe(
      `Basic ${Buffer.from(`user:${CANARY}`).toString("base64")}`,
    );
    expectNoCredential(result);
  });

  it("launcher without a proxy variable: nothing reaches the proxy and the name is looked up", async () => {
    const fixture = await startProxyFixture(roots, closers);
    const result = await runGuardedNode(
      fixture,
      [...LAUNCHER, ...CATALOG],
      childEnvironment(fixture, catalogEnvironment),
      processDeadline(),
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Inference catalog: unavailable (network-failure)");
    expect(fixture.proxyLog).toEqual([]);
    expect(await dnsAttempts(fixture)).toContain("api.openai.com");
  });

  it.each([
    ["plain", false],
    ["symlinked", true],
  ])("cli.ts direct run (%s)", async (_, linked) => {
    const fixture = await startProxyFixture(roots, closers);
    let entry = join(RUNTIME_ROOT, "src", "cli.ts");
    if (linked) {
      const directory = await roots.create("docsfab-cli-link-");
      const link = join(directory, "cli.ts");
      await symlink(entry, link);
      entry = link;
    }
    const result = await runGuardedNode(
      fixture,
      ["--import", "tsx", entry, ...CATALOG],
      childEnvironment(fixture, { ...catalogEnvironment, HTTPS_PROXY: fixture.proxyUrl }),
      processDeadline(),
    );
    await expectCatalogThroughProxy(fixture, result);
  });

  it("npm run dev (tsx src/cli.ts)", async () => {
    const fixture = await startProxyFixture(roots, closers);
    const result = await runGuardedNode(
      fixture,
      [join(RUNTIME_ROOT, "node_modules", "tsx", "dist", "cli.mjs"), "src/cli.ts", ...CATALOG],
      childEnvironment(fixture, { ...catalogEnvironment, HTTPS_PROXY: fixture.proxyUrl }),
      processDeadline(),
    );
    await expectCatalogThroughProxy(fixture, result);
  });

  it("runCliEntrypoint (symlinked): a model turn through the agent library goes through the proxy", async () => {
    const fixture = await startProxyFixture(roots, closers);
    const directory = await roots.create("docsfab-entry-link-");
    const entry = join(directory, "entry.mts");
    const link = join(directory, "linked-entry.mts");
    const source = (path: string) => JSON.stringify(pathToFileURL(join(RUNTIME_ROOT, path)).href);
    await writeFile(
      entry,
      `import { runCliEntrypoint } from ${source("src/operator/cli-entrypoint.ts")};
import { createModelConnection } from ${source("src/model/provider.ts")};
import { parseModelEndpoint } from ${source("src/model/configuration.ts")};
runCliEntrypoint(import.meta.url, async () => {
  // Backoff collapsed: the direct control fails fast instead of waiting out retries.
  const connection = await createModelConnection(parseModelEndpoint(process.env), {
    evidenceIdentity: { repositoryRevision: "a".repeat(40) },
    providerTurnRetry: { baseDelayMs: 0, maxDelayMs: 0 },
  });
  const result = await connection.runtime.completeSimple(
    connection.model,
    { systemPrompt: "Proxy fixture.", messages: [{ role: "user", content: "Reply OK.", timestamp: 1 }] },
    { maxRetries: 0 },
  );
  console.log(JSON.stringify({ stopReason: result.stopReason, error: result.errorMessage ?? null }));
  return { exitCode: 0 };
});
`,
    );
    await symlink(entry, link);
    const environment = {
      ...validModelEnvironment,
      MODEL_BASE_URL: "https://models.example.test/v1",
    };

    const proxied = await runGuardedNode(
      fixture,
      ["--import", "tsx", link],
      childEnvironment(fixture, { ...environment, HTTPS_PROXY: fixture.proxyUrl }),
      processDeadline(),
    );
    expect(proxied.stderr).toBe("");
    expect(JSON.parse(proxied.stdout)).toEqual({ stopReason: "stop", error: null });
    expect(fixture.proxyLog.map((entry) => entry.line)).toEqual([
      "CONNECT models.example.test:443 HTTP/1.1",
    ]);
    expect(fixture.targetRequests).toEqual([
      { host: "models.example.test", method: "POST", url: "/v1/chat/completions" },
    ]);

    // Positive control: without a proxy variable the name is looked up and refused.
    const direct = await runGuardedNode(
      fixture,
      ["--import", "tsx", link],
      childEnvironment(fixture, environment),
      processDeadline(),
    );
    expect(JSON.parse(direct.stdout)).toMatchObject({ stopReason: "error" });
    expect(fixture.proxyLog).toHaveLength(1);
    expect(await dnsAttempts(fixture)).toContain("models.example.test");
  });
});

describe("refusals at first outbound use", { timeout: testTimeoutMs(localCaseMs) }, () => {
  it.each(["http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY"])(
    "an invalid %s refuses the https catalog request by name, starts, and never echoes the value",
    async (name) => {
      const fixture = await startProxyFixture(roots, closers);
      const result = await runGuardedNode(
        fixture,
        [...LAUNCHER, ...CATALOG],
        childEnvironment(fixture, {
          ...catalogEnvironment,
          [name]: `http://user:${CANARY}@pro xy:3128`,
        }),
        processDeadline(),
      );
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        `Refused an outbound HTTPS request because ${name} contains whitespace inside the URL (outbound-proxy-invalid). Nothing was sent.`,
      );
      expect(result.stderr).toContain("code: outbound-proxy-invalid");
      expect(result.stderr).toContain("Next action: Set the named proxy variable");
      expect(fixture.proxyLog).toEqual([]);
      expect(fixture.targetRequests).toEqual([]);
      expect(await dnsAttempts(fixture)).toEqual([]);
      expectNoCredential(result);
    },
  );

  // Node's proxy agent decodes the password and throws a bare URIError on a
  // bad escape; unscreened, that stopped every command, doctor included.
  it.each(["http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY"])(
    "a %s password with a bare percent sign starts doctor and the catalog, refuses by name, and never echoes it",
    async (name) => {
      const value = `http://user:${CANARY}%ss@proxy.example.test:3128`;
      const doctorFixture = await startProxyFixture(roots, closers);
      const doctor = await runGuardedNode(
        doctorFixture,
        [...LAUNCHER, "doctor", "--repo", doctorFixture.root],
        childEnvironment(doctorFixture, { [name]: value }),
        processDeadline(),
      );
      expect(doctor.stderr).not.toContain("URI malformed");
      expect(doctor.code).toBe(1);
      expect(doctor.stdout).toContain("Code: outbound-proxy-invalid");
      expect(doctor.stdout).toContain(
        `${name} has a user name or password with an invalid percent escape; write % as %25`,
      );
      expect(doctor.stdout).toContain(
        `${name.toLowerCase().startsWith("https") ? "https" : "http"}: refused (${name})`,
      );
      expectNoCredential(doctor);

      const fixture = await startProxyFixture(roots, closers);
      const result = await runGuardedNode(
        fixture,
        [...LAUNCHER, ...CATALOG],
        childEnvironment(fixture, { ...catalogEnvironment, [name]: value }),
        processDeadline(),
      );
      expect(result.code).toBe(1);
      expect(result.stderr).not.toContain("URI malformed");
      expect(result.stderr).toContain(
        `Refused an outbound HTTPS request because ${name} has a user name or password with an invalid percent escape`,
      );
      expect(result.stderr).toContain("code: outbound-proxy-invalid");
      expect(fixture.proxyLog).toEqual([]);
      expect(fixture.targetRequests).toEqual([]);
      expect(await dnsAttempts(fixture)).toEqual([]);
      expectNoCredential(result);
    },
  );

  it("an invalid HTTP_PROXY beside a valid HTTPS_PROXY still proxies https", async () => {
    const fixture = await startProxyFixture(roots, closers);
    const result = await runGuardedNode(
      fixture,
      [...LAUNCHER, ...CATALOG],
      childEnvironment(fixture, {
        ...catalogEnvironment,
        HTTP_PROXY: `http://user:${CANARY}@pro xy:3128`,
        HTTPS_PROXY: fixture.proxyUrl,
      }),
      processDeadline(),
    );
    await expectCatalogThroughProxy(fixture, result);
    expectNoCredential(result);
  });

  it("a SOCKS proxy is refused by name", async () => {
    const fixture = await startProxyFixture(roots, closers);
    const result = await runGuardedNode(
      fixture,
      [...LAUNCHER, ...CATALOG],
      childEnvironment(fixture, { ...catalogEnvironment, HTTPS_PROXY: "socks5://127.0.0.1:1" }),
      processDeadline(),
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("HTTPS_PROXY names a SOCKS proxy");
    expect(fixture.proxyLog).toEqual([]);
    expect(await dnsAttempts(fixture)).toEqual([]);
  });
});

describe("doctor proxy section", { timeout: testTimeoutMs(localCaseMs) }, () => {
  it("shows the effective proxy redacted and never dials it", async () => {
    const fixture = await startProxyFixture(roots, closers);
    const result = await runGuardedNode(
      fixture,
      [...LAUNCHER, "doctor", "--repo", fixture.root],
      childEnvironment(fixture, {
        HTTPS_PROXY: credentialedProxy(fixture),
        no_proxy: "internal.example.test",
      }),
      processDeadline(),
    );
    expect(result.stdout).toContain(
      `https: http://127.0.0.1:${String(fixture.proxyPort)} (from HTTPS_PROXY)`,
    );
    expect(result.stdout).toContain("http: none");
    expect(result.stdout).toContain("NO_PROXY: internal.example.test (from no_proxy)");
    expect(result.stdout).toContain("Built-in proxy support: on (turned on by DocsFab)");
    expect(fixture.proxyLog).toEqual([]);
    expectNoCredential(result);
  });

  it("reports support as available, not on, when no proxy variable is set", async () => {
    const fixture = await startProxyFixture(roots, closers);
    const result = await runGuardedNode(
      fixture,
      [...LAUNCHER, "doctor", "--repo", fixture.root],
      childEnvironment(fixture, {}),
      processDeadline(),
    );
    expect(result.stdout).toContain("https: none");
    expect(result.stdout).toContain(
      "Built-in proxy support: available; each docsfab command turns it on when a proxy variable is set",
    );
  });

  it("fails the doctor line for an invalid setting", async () => {
    const fixture = await startProxyFixture(roots, closers);
    const result = await runGuardedNode(
      fixture,
      [...LAUNCHER, "doctor", "--repo", fixture.root],
      childEnvironment(fixture, { HTTPS_PROXY: `http://user:${CANARY}@pro xy:3128` }),
      processDeadline(),
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("Code: outbound-proxy-invalid");
    expect(result.stdout).toContain("HTTPS_PROXY contains whitespace inside the URL");
    expect(result.stdout).toContain("https: refused (HTTPS_PROXY)");
    expectNoCredential(result);
  });
});

describe("bypass with proxy support on", { timeout: testTimeoutMs(localCaseMs) }, () => {
  const CHILD = (targets: readonly string[]) => `
import { ensureBuiltInProxy, outboundFetch } from ${JSON.stringify(
    pathToFileURL(join(RUNTIME_ROOT, "src/model/outbound-http-policy.ts")).href,
  )};
ensureBuiltInProxy();
const results = [];
for (const target of ${JSON.stringify(targets)}) {
  try {
    results.push({ target, status: (await outboundFetch()(target)).status });
  } catch (error) {
    results.push({ target, error: error.code ?? error.cause?.code ?? String(error) });
  }
}
console.log(JSON.stringify(results));
`;

  async function runChild(fixture: ProxyFixture, targets: string[], env: Record<string, string>) {
    const directory = await roots.create("docsfab-bypass-child-");
    const script = join(directory, "child.mts");
    await writeFile(script, CHILD(targets));
    const result = await runGuardedNode(
      fixture,
      ["--import", "tsx", script],
      childEnvironment(fixture, env),
      processDeadline(),
    );
    expect(result.stderr).toBe("");
    return JSON.parse(result.stdout) as Array<{ target: string; status?: number; error?: string }>;
  }

  it("sends every loopback target direct and the rest through the proxy", async () => {
    const fixture = await startProxyFixture(roots, closers);
    const port = String(fixture.targetPort);
    const results = await runChild(
      fixture,
      [
        `https://localhost:${port}/a`,
        `https://127.0.0.1:${port}/b`,
        `https://[::1]:${port}/c`,
        "https://models.example.test/d",
      ],
      { HTTPS_PROXY: fixture.proxyUrl },
    );
    expect(results.map((item) => item.status)).toEqual([404, 404, 404, 404]);
    expect(fixture.proxyLog.map((entry) => entry.line)).toEqual([
      "CONNECT models.example.test:443 HTTP/1.1",
    ]);
    expect(fixture.targetRequests.map((request) => request.url)).toEqual(["/a", "/b", "/c", "/d"]);
  });

  it("an invalid https setting never refuses a loopback target", async () => {
    const fixture = await startProxyFixture(roots, closers);
    const results = await runChild(fixture, [`https://localhost:${String(fixture.targetPort)}/a`], {
      HTTPS_PROXY: "socks5://127.0.0.1:1",
    });
    expect(results).toEqual([
      { target: `https://localhost:${String(fixture.targetPort)}/a`, status: 404 },
    ]);
    expect(fixture.proxyLog).toEqual([]);
  });

  it("NO_PROXY sends a listed host direct and keeps the rest proxied", async () => {
    const fixture = await startProxyFixture(roots, closers);
    const results = await runChild(
      fixture,
      ["https://models.example.test/a", "https://api.openai.com/b"],
      { HTTPS_PROXY: fixture.proxyUrl, NO_PROXY: "models.example.test" },
    );
    expect(results[0]).toEqual({ target: "https://models.example.test/a", error: "ENOTFOUND" });
    expect(results[1]).toEqual({ target: "https://api.openai.com/b", status: 404 });
    expect(fixture.proxyLog.map((entry) => entry.line)).toEqual([
      "CONNECT api.openai.com:443 HTTP/1.1",
    ]);
    expect(await dnsAttempts(fixture)).toEqual(["models.example.test"]);
  });

  // The running Node's dispatcher is the oracle for DocsFab's own NO_PROXY
  // reading, which decides when a request is exempt from refusal.
  it.each([
    ["example.test", true],
    [".models.example.test", true],
    ["*.models.example.test", true],
    ["*example.test", false],
    ["models.example.test:8443", false],
  ])("Node and DocsFab agree on NO_PROXY=%s", async (noProxy, bypassed) => {
    const fixture = await startProxyFixture(roots, closers);
    const target = "https://models.example.test/a";
    expect(isBypassedByNoProxy(new URL(target), noProxy)).toBe(bypassed);
    const results = await runChild(fixture, [target], {
      HTTPS_PROXY: fixture.proxyUrl,
      NO_PROXY: noProxy,
    });
    expect(results).toEqual([bypassed ? { target, error: "ENOTFOUND" } : { target, status: 404 }]);
    expect(fixture.proxyLog.length).toBe(bypassed ? 0 : 1);
  });
});
