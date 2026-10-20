// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  OUTBOUND_PROXY_AUTH_REQUIRED_CODE,
  OUTBOUND_PROXY_DENIED_CODE,
  OUTBOUND_PROXY_UNREACHABLE_CODE,
} from "../src/model/outbound-http-policy.js";
import { temporaryRoots } from "./helpers/temp.js";
import { nestedDeadlineMs, testTimeoutMs } from "./helpers/test-timeouts.js";
import {
  childEnvironment,
  PROXY_REFUSAL_CANARY,
  RUNTIME_ROOT,
  runGuardedNode,
  startProxyFixture,
} from "./support/outbound-proxy-fixture.js";

// Local budgets in ms for one tsx-compiled child that runs every row in
// sequence; in CI each case gets at least test.ciTimeoutMs.
const localCaseMs = 90_000;
const localProcessMs = 60_000;
const processDeadline = () => nestedDeadlineMs(localProcessMs, localCaseMs);

const roots = temporaryRoots();
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

const OWN_PREFIXES = ["docsfab-proxy-roadmap-"];
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

/** A loopback port with nothing listening: bound once, then released. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

const source = (path: string) => JSON.stringify(pathToFileURL(join(RUNTIME_ROOT, path)).href);

/** Read only by the target; a refusal or error that echoed it would show it. */
const TOKEN_CANARY = "CANARYROADMAPREADTOKEN";
/** A fixture host, so the proxy's healthy tunnel reaches the local TLS server. */
const GITLAB_HOST = "models.example.test";

/**
 * Runs `runRoadmapPlanCli` once per row with no injected reader, so the reader
 * it builds uses its default fetch. Proxy support is turned on the way the
 * shipped entries do it, inside the child, so the vitest worker keeps Node's
 * own dispatcher.
 */
const CHILD = `
const policy = await import(${source("src/model/outbound-http-policy.ts")});
const roadmap = await import(${source("src/roadmap/index.ts")});
const rows = JSON.parse(process.env.ROADMAP_ROWS);
const PROXY_NAMES = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NO_PROXY", "no_proxy"];

function causeCodes(error) {
  const codes = [];
  const seen = new Set();
  for (let item = error; item && typeof item === "object" && !seen.has(item); item = item.cause) {
    seen.add(item);
    codes.push(item.code ?? null);
  }
  return codes;
}

const REVISION = "a".repeat(40);
const CONTENT = "b".repeat(64);
const project = { provider: "gitlab", host: ${JSON.stringify(GITLAB_HOST)}, fullPath: "group/docsfab", projectId: 7 };
const docAudit = {
  kind: "authenticated-doc-audit-package",
  schemaVersion: 1,
  runId: "run:audit",
  workflow: "review-documentation",
  status: "succeeded",
  repositoryRevision: REVISION,
  repositoryContentDigest: CONTENT,
  projectIdentityDigest: roadmap.roadmapDigest(project),
  findings: [],
  digest: "0".repeat(64),
};
docAudit.digest = roadmap.roadmapDigest(docAudit);
const input = {
  kind: "docsfab-roadmap-planning-input",
  schemaVersion: 1,
  mode: "health",
  repository: { revision: REVISION, contentDigest: CONTENT },
  project,
  observedAt: "2026-08-05T00:00:00.000Z",
  expiresAt: "2026-08-05T00:01:00.000Z",
  units: [],
  candidates: [],
  semanticReconciliation: [],
  proposalCap: 5,
  docAudit,
};

const results = {};
for (const row of rows) {
  for (const name of PROXY_NAMES) delete process.env[name];
  process.env.HTTPS_PROXY = row.proxy;
  policy.resetOutboundProxyStateForTests();
  policy.ensureBuiltInProxy();
  try {
    await roadmap.runRoadmapPlanCli(
      ["--mode", "health", "--input", "input.json", "--repo", ".", "--revision", REVISION, "--json"],
      {
        inspectRepository: async () => ({ revision: REVISION, contentDigest: CONTENT }),
        readJson: async () => input,
        log: () => undefined,
        environment: { GITLAB_TOKEN: process.env.ROADMAP_TOKEN },
        trustedProject: project,
        trustedSourceDigest: roadmap.roadmapDigest({ source: roadmap.decodeRoadmapPlanningInput(input) }),
      },
    );
    results[row.id] = null;
  } catch (error) {
    results[row.id] = {
      name: error?.name ?? null,
      code: typeof error?.code === "string" ? error.code : null,
      message: String(error?.message),
      causeCodes: causeCodes(error),
    };
  }
}
process.stdout.write(JSON.stringify(results), () => process.exit(0));
`;

interface RowOutcome {
  readonly name: string | null;
  readonly code: string | null;
  readonly message: string;
  readonly causeCodes: Array<string | number | null>;
}

describe("GitLab roadmap reads through a proxy", { timeout: testTimeoutMs(localCaseMs) }, () => {
  it("runRoadmapPlanCli's default fetch codes 403, 407 and an unreachable proxy, and keeps a healthy tunnel and a 502 uncoded", async () => {
    const fixture = await startProxyFixture(roots, closers, "docsfab-proxy-roadmap-");
    const closed = await closedPort();
    const rows = [
      { id: "denied", proxy: fixture.proxyUrl },
      { id: "auth-required", proxy: fixture.proxyUrl },
      { id: "unreachable", proxy: `http://127.0.0.1:${String(closed)}` },
      { id: "healthy", proxy: fixture.proxyUrl },
      { id: "tunnel-502", proxy: fixture.proxyUrl },
    ];
    fixture.script([
      { kind: "status", status: 403 },
      { kind: "status", status: 407 },
      { kind: "tunnel" },
      { kind: "status", status: 502 },
    ]);
    const directory = await roots.create("docsfab-proxy-roadmap-child-");
    const script = join(directory, "child.mts");
    await writeFile(script, CHILD);
    const result = await runGuardedNode(
      fixture,
      ["--import", "tsx", script],
      childEnvironment(fixture, {
        ROADMAP_ROWS: JSON.stringify(rows),
        ROADMAP_TOKEN: TOKEN_CANARY,
      }),
      processDeadline(),
    );
    expect(result.stderr).toBe("");
    const outcomes = JSON.parse(result.stdout) as Record<string, RowOutcome | null>;

    for (const form of [TOKEN_CANARY, PROXY_REFUSAL_CANARY]) {
      expect(result.stdout).not.toContain(form);
    }
    const nothingSent = `Nothing was sent to ${GITLAB_HOST}.`;
    expect(outcomes.denied).toEqual({
      name: "OutboundProxyRefusal",
      code: OUTBOUND_PROXY_DENIED_CODE,
      message: `The HTTPS_PROXY proxy refused to open a tunnel to ${GITLAB_HOST} with HTTP 403 (${OUTBOUND_PROXY_DENIED_CODE}). ${nothingSent}`,
      causeCodes: [OUTBOUND_PROXY_DENIED_CODE],
    });
    expect(outcomes["auth-required"]).toEqual({
      name: "OutboundProxyRefusal",
      code: OUTBOUND_PROXY_AUTH_REQUIRED_CODE,
      message: `The HTTPS_PROXY proxy asked for proxy authentication with HTTP 407 before opening a tunnel to ${GITLAB_HOST} (${OUTBOUND_PROXY_AUTH_REQUIRED_CODE}). ${nothingSent}`,
      causeCodes: [OUTBOUND_PROXY_AUTH_REQUIRED_CODE],
    });
    expect(outcomes.unreachable).toEqual({
      name: "OutboundProxyRefusal",
      code: OUTBOUND_PROXY_UNREACHABLE_CODE,
      message: `Could not connect to the HTTPS_PROXY proxy for an outbound HTTPS request: ECONNREFUSED (${OUTBOUND_PROXY_UNREACHABLE_CODE}). ${nothingSent}`,
      causeCodes: [OUTBOUND_PROXY_UNREACHABLE_CODE],
    });
    // Positive control: the tunnel opened and the read reached the target,
    // whose 404 the reader reports as its own failure.
    expect(outcomes.healthy).toEqual({
      name: "Error",
      code: null,
      message: "GitLab read-only issue observation failed (404).",
      causeCodes: [null],
    });
    // Adjacent: any other tunnel reply stays Node's raw transport error.
    expect(outcomes["tunnel-502"]).toMatchObject({
      name: "TypeError",
      code: null,
      message: "fetch failed",
      causeCodes: [null, 0, "UND_ERR_ABORTED"],
    });

    // One CONNECT per proxied row; the unreachable row never reached the fixture.
    expect(fixture.proxyLog.map((entry) => entry.line)).toEqual(
      Array<string>(4).fill(`CONNECT ${GITLAB_HOST}:443 HTTP/1.1`),
    );
    expect(fixture.proxyConnections()).toBe(4);
    // Only the healthy row sent anything to the target.
    expect(fixture.targetRequests).toHaveLength(1);
    expect(fixture.targetRequests[0]).toMatchObject({ host: GITLAB_HOST, method: "GET" });
    expect(fixture.targetRequests[0]?.url?.startsWith("/api/v4/projects/7/issues?")).toBe(true);
    expect((await readFile(fixture.dnsLogPath, "utf8")).split("\n").filter(Boolean)).toEqual([]);
  });
});
