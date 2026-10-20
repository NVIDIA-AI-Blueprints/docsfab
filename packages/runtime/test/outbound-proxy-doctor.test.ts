// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { resolveDocsFabPrivateRoots } from "../src/init/project-config.js";
import {
  OUTBOUND_PROXY_AUTH_REQUIRED_CODE,
  OUTBOUND_PROXY_AUTH_REQUIRED_NEXT_ACTION,
  OUTBOUND_PROXY_DENIED_CODE,
  OUTBOUND_PROXY_DENIED_NEXT_ACTION,
  OUTBOUND_PROXY_INVALID_CODE,
  OUTBOUND_PROXY_INVALID_NEXT_ACTION,
  OUTBOUND_PROXY_UNREACHABLE_CODE,
  OUTBOUND_PROXY_UNREACHABLE_NEXT_ACTION,
} from "../src/model/outbound-http-policy.js";
import { validModelEnvironment } from "./helpers.js";
import { temporaryRoots } from "./helpers/temp.js";
import { nestedDeadlineMs, testTimeoutMs } from "./helpers/test-timeouts.js";
import {
  childEnvironment,
  PROXY_REFUSAL_CANARY,
  RUNTIME_ROOT,
  runGuardedNode,
  startProxyFixture,
  type ChildResult,
  type ConnectReply,
  type ProxyFixture,
} from "./support/outbound-proxy-fixture.js";

const execute = promisify(execFile);

// Local budgets in ms for tsx-compiled DocsFab children. A live check through
// an unreachable proxy on the Pi-session path spends the default in-turn
// backoff, about 51.5 s, before it reports.
const localCaseMs = 150_000;
const localProcessMs = 120_000;
const processDeadline = () => nestedDeadlineMs(localProcessMs, localCaseMs);

const roots = temporaryRoots();
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

const OWN_PREFIXES = ["docsfab-proxy-doctor-"];
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

/** A placeholder key generated here, never a real credential. */
const MODEL_KEY = `sk-${"A".repeat(24)}`;
/** The proxy password; `%40` makes its decoded form differ from the raw one. */
const CANARY = "CANARY%40PW";
const CANARY_FORMS = [
  CANARY,
  decodeURIComponent(CANARY),
  Buffer.from(`user:${decodeURIComponent(CANARY)}`).toString("base64"),
  Buffer.from(`user:${CANARY}`).toString("base64"),
];

const LAUNCHER = ["--import", "tsx", "src/launcher.ts"] as const;

const MODEL_FORMATS = {
  chat: {
    MODEL_API_FORMAT: "chat_completions",
    MODEL_COMPATIBLE_API_FORMATS: "chat_completions",
  },
  // A non-chat format: the endpoint probe skips it, so only the Pi session runs.
  messages: {
    MODEL_API_FORMAT: "messages",
    MODEL_COMPATIBLE_API_FORMATS: "messages",
    MODEL_TRANSPORT: "anthropic-messages",
  },
} as const;
type ModelFormat = keyof typeof MODEL_FORMATS;

function modelEnvironment(format: ModelFormat): Record<string, string> {
  return {
    ...validModelEnvironment,
    ...MODEL_FORMATS[format],
    MODEL_BASE_URL: "https://models.example.test/v1",
    MODEL_API_KEY: MODEL_KEY,
    JUDGE_ENABLED: "false",
  };
}

interface ReadyRepository {
  readonly root: string;
  readonly repository: string;
  readonly glabLog: string;
  readonly environment: Record<string, string>;
}

/**
 * A checkout `docsfab doctor` reports ready offline: a tracked project
 * configuration, a GitLab remote, owner-private state, and a PATH-first glab
 * shim that answers the version and credential probes and records the live API
 * attempt without contacting GitLab.
 */
async function readyRepository(): Promise<ReadyRepository> {
  const root = await roots.create("docsfab-proxy-doctor-", { realpath: true });
  const repository = join(root, "repository");
  const home = join(root, "home");
  const state = join(root, "state");
  const bin = join(root, "bin");
  const glabLog = join(root, "glab.log");
  await Promise.all([mkdir(repository), mkdir(home), mkdir(state), mkdir(bin)]);
  const git = (...args: string[]) => execute("git", ["-C", repository, ...args]);
  await git("init", "-q", "-b", "main");
  await git("config", "user.name", "Operator");
  await git("config", "user.email", "operator@example.test");
  await git("remote", "add", "origin", "https://gitlab.example.test/group/project.git");
  await writeFile(
    join(repository, ".docsfab.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      gitlab: { remote: "origin", defaultBranch: "main" },
      provider: { configuration: "host" },
      storage: { scope: "user-private" },
    })}\n`,
  );
  await git("add", ".docsfab.json");
  await git("commit", "-q", "-m", "init");
  const privateRoots = resolveDocsFabPrivateRoots(repository, { XDG_STATE_HOME: state }, home);
  for (const path of Object.values(privateRoots)) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    await chmod(path, 0o700);
  }
  await writeFile(
    join(bin, "glab"),
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> '${glabLog}'`,
      'case "$1" in',
      '  --version|version) echo "glab version 1.0.0"; exit 0 ;;',
      "  config|auth) exit 0 ;;",
      "  *) exit 1 ;;",
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  await writeFile(glabLog, "");
  return {
    root,
    repository,
    glabLog,
    environment: {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      HOME: home,
      XDG_STATE_HOME: state,
    },
  };
}

interface DoctorDiagnostic {
  readonly area: string;
  readonly code: string;
  readonly explanation: string;
  readonly nextCommand: string;
}

interface DoctorJson {
  readonly diagnostics: DoctorDiagnostic[];
  readonly liveConnectivity: { readonly provider: string };
}

/** Every file under `root`, read whole; the proxy password must be in none. */
async function filesContaining(root: string, needle: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(root, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    if ((await readFile(path)).includes(needle)) found.push(path);
  }
  return found;
}

async function expectNothingLeaked(result: ChildResult, directories: string[]): Promise<void> {
  for (const form of [...CANARY_FORMS, PROXY_REFUSAL_CANARY, MODEL_KEY]) {
    expect(result.stdout).not.toContain(form);
    expect(result.stderr).not.toContain(form);
    for (const directory of directories) expect(await filesContaining(directory, form)).toEqual([]);
  }
}

const EXPECTED = {
  denied: {
    reply: { kind: "status", status: 403 },
    code: OUTBOUND_PROXY_DENIED_CODE,
    nextAction: OUTBOUND_PROXY_DENIED_NEXT_ACTION,
    explanation: "refused to open a tunnel to models.example.test with HTTP 403",
  },
  "auth-required": {
    reply: { kind: "status", status: 407 },
    code: OUTBOUND_PROXY_AUTH_REQUIRED_CODE,
    nextAction: OUTBOUND_PROXY_AUTH_REQUIRED_NEXT_ACTION,
    explanation: "asked for proxy authentication with HTTP 407",
  },
  unreachable: {
    reply: undefined,
    code: OUTBOUND_PROXY_UNREACHABLE_CODE,
    nextAction: OUTBOUND_PROXY_UNREACHABLE_NEXT_ACTION,
    explanation:
      "Could not connect to the HTTPS_PROXY proxy for an outbound HTTPS request: ENOTFOUND (outbound-proxy-unreachable)",
  },
} as const satisfies Record<
  string,
  {
    reply: ConnectReply | undefined;
    code: string;
    nextAction: string;
    explanation: string;
  }
>;
type Kind = keyof typeof EXPECTED;

/** The DNS guard returns a controlled low-level ENOTFOUND for this proxy host. */
const UNREACHABLE_PROXY_HOST = "proxy-unreachable.docsfab.test";

/** The proxy setting for a case: the fixture, or its guarded-DNS proxy host. */
function proxyFor(fixture: ProxyFixture, kind: Kind): string {
  const host = kind === "unreachable" ? UNREACHABLE_PROXY_HOST : "127.0.0.1";
  return `http://user:${CANARY}@${host}:${String(fixture.proxyPort)}`;
}

async function guardedDnsAttempts(fixture: ProxyFixture): Promise<string[]> {
  return (await readFile(fixture.dnsLogPath, "utf8")).split("\n").filter(Boolean);
}

async function expectGuardedProxyDnsRefusal(fixture: ProxyFixture): Promise<void> {
  const attempts = await guardedDnsAttempts(fixture);
  expect(attempts).toContain(UNREACHABLE_PROXY_HOST);
  expect(attempts).not.toContain("models.example.test");
}

async function expectIsolatedGuardedProxyDnsRefusal(fixture: ProxyFixture): Promise<void> {
  await expectGuardedProxyDnsRefusal(fixture);
  expect(fixture.proxyConnections()).toBe(0);
  expect(fixture.targetRequests).toEqual([]);
}

async function liveDoctor(
  fixture: ProxyFixture,
  format: ModelFormat,
  proxy: string,
  proxyEnvironment: Record<string, string> = {},
): Promise<{ result: ChildResult; json: DoctorJson; ready: ReadyRepository }> {
  const ready = await readyRepository();
  const result = await runGuardedNode(
    fixture,
    [...LAUNCHER, "doctor", "--repo", ready.repository, "--live", "--json"],
    childEnvironment(fixture, {
      ...modelEnvironment(format),
      ...ready.environment,
      HTTPS_PROXY: proxy,
      ...proxyEnvironment,
    }),
    processDeadline(),
  );
  // The shim answered every GitLab probe; no real glab and no GitLab contact.
  const glab = await readFile(ready.glabLog, "utf8");
  expect(glab).toContain("--version");
  expect(glab).toContain("auth status --hostname gitlab.example.test");
  expect(glab).toContain("api --hostname gitlab.example.test");
  return { result, json: JSON.parse(result.stdout) as DoctorJson, ready };
}

/**
 * `diagnose(config, { live: true })` called directly, the other live path;
 * each listed proxy setting runs in turn in one child.
 */
const DIAGNOSE_CHILD = `
const { loadConfig } = await import(${JSON.stringify(pathToFileURL(join(RUNTIME_ROOT, "src/config/runtime-loader.ts")).href)});
const { diagnose } = await import(${JSON.stringify(pathToFileURL(join(RUNTIME_ROOT, "src/doctor.ts")).href)});
const policy = await import(${JSON.stringify(pathToFileURL(join(RUNTIME_ROOT, "src/model/outbound-http-policy.ts")).href)});
const results = [];
for (const proxy of JSON.parse(process.env.PROXIES)) {
  process.env.HTTPS_PROXY = proxy;
  policy.resetOutboundProxyStateForTests();
  policy.ensureBuiltInProxy();
  try {
    const result = await diagnose(loadConfig(), { live: true });
    results.push({ passed: Boolean(result.live) });
  } catch (error) {
    results.push({ name: error.name, code: error.code ?? null, message: error.message, nextAction: error.nextAction ?? null });
  }
}
process.stdout.write(JSON.stringify(results), () => process.exit(0));
`;

async function diagnoseDirectly(
  fixture: ProxyFixture,
  format: ModelFormat,
  proxies: readonly string[],
): Promise<{
  result: ChildResult;
  outcomes: Array<Record<string, unknown>>;
  root: string;
}> {
  const ready = await readyRepository();
  const script = join(ready.root, "diagnose.mts");
  await writeFile(script, DIAGNOSE_CHILD);
  const result = await runGuardedNode(
    fixture,
    ["--import", "tsx", script],
    childEnvironment(fixture, {
      ...modelEnvironment(format),
      ...ready.environment,
      PROXIES: JSON.stringify(proxies),
    }),
    processDeadline(),
  );
  expect(result.stderr).toBe("");
  return { result, outcomes: JSON.parse(result.stdout), root: ready.root };
}

describe("doctor --catalog through a refusing proxy", {
  timeout: testTimeoutMs(localCaseMs),
}, () => {
  const catalogEnvironment = {
    ...validModelEnvironment,
    MODEL_PROVIDER: "openai",
    MODEL_BASE_URL: "https://api.openai.com/v1",
    MODEL_ID: "gpt-5.4",
    MODEL_API_KEY: MODEL_KEY,
    JUDGE_ENABLED: "false",
  };

  async function catalogDoctor(reply: ConnectReply) {
    const fixture = await startProxyFixture(roots, closers, "docsfab-proxy-doctor-fixture-");
    fixture.script([reply]);
    const ready = await readyRepository();
    const result = await runGuardedNode(
      fixture,
      [...LAUNCHER, "doctor", "--repo", ready.repository, "--catalog"],
      childEnvironment(fixture, {
        ...catalogEnvironment,
        ...ready.environment,
        HTTPS_PROXY: `http://user:${CANARY}@127.0.0.1:${String(fixture.proxyPort)}`,
      }),
      processDeadline(),
    );
    expect(fixture.proxyLog.map((entry) => entry.line)).toEqual([
      "CONNECT api.openai.com:443 HTTP/1.1",
    ]);
    expect(fixture.proxyConnections()).toBe(1);
    await expectNothingLeaked(result, [ready.root, fixture.root]);
    return { fixture, result };
  }

  it.each(["denied", "auth-required"] as const)(
    "names %s with its next action before any request reaches the target",
    async (kind) => {
      const { fixture, result } = await catalogDoctor(EXPECTED[kind].reply);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        EXPECTED[kind].explanation.replace("models.example.test", "api.openai.com"),
      );
      expect(result.stderr).toContain(`code: ${EXPECTED[kind].code}`);
      expect(result.stderr).toContain(`Next action: ${EXPECTED[kind].nextAction}`);
      expect(fixture.targetRequests).toEqual([]);
    },
  );

  it("a healthy tunnel reaches the catalog", async () => {
    const { fixture, result } = await catalogDoctor({ kind: "tunnel" });
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Direct-provider catalog unavailable (model-absent)");
    expect(fixture.targetRequests).toEqual([
      { host: "api.openai.com", method: "GET", url: "/v1/models/gpt-5.4" },
    ]);
  });

  it("a 502 tunnel reply keeps the catalog's own network failure", async () => {
    const { result } = await catalogDoctor({ kind: "status", status: 502 });
    expect(result.stdout).toContain("Direct-provider catalog unavailable (network-failure)");
    expect(`${result.stdout}${result.stderr}`).not.toContain("outbound-proxy-");
  });
});

describe("doctor --live through a failing proxy", { timeout: testTimeoutMs(localCaseMs) }, () => {
  it.each([
    ["chat", "denied"],
    ["chat", "auth-required"],
    ["chat", "unreachable"],
    ["messages", "denied"],
    ["messages", "auth-required"],
  ] as const)("%s format, readiness path: names %s", async (format, kind) => {
    const fixture = await startProxyFixture(roots, closers, "docsfab-proxy-doctor-fixture-");
    const reply = EXPECTED[kind].reply;
    if (reply) fixture.script([], reply);
    const { result, json, ready } = await liveDoctor(fixture, format, proxyFor(fixture, kind));
    expect(result.code).toBe(1);
    expect(json.liveConnectivity.provider).toBe("failed");
    const provider = json.diagnostics.filter((entry) => entry.area === "provider");
    expect(provider).toEqual([
      expect.objectContaining({
        code: EXPECTED[kind].code,
        nextCommand: EXPECTED[kind].nextAction,
      }),
    ]);
    expect(provider[0]!.explanation).toContain(EXPECTED[kind].explanation);
    expect(fixture.targetRequests).toEqual([]);
    // The tunnel was refused once; nothing replayed it.
    expect(fixture.proxyConnections()).toBe(kind === "unreachable" ? 0 : 1);
    if (kind === "unreachable") await expectIsolatedGuardedProxyDnsRefusal(fixture);
    if (kind !== "unreachable") {
      // The decoded password did reach the proxy, so its absence below is a real check.
      expect(fixture.proxyLog[0]?.proxyAuthorization).toBe(`Basic ${CANARY_FORMS[2]!}`);
    }
    await expectNothingLeaked(result, [ready.root, fixture.root]);
  });

  it("messages format, both paths: names an unreachable proxy after the in-turn backoff", async () => {
    const fixture = await startProxyFixture(roots, closers, "docsfab-proxy-doctor-fixture-");
    const proxy = proxyFor(fixture, "unreachable");
    const [readiness, direct] = await Promise.all([
      liveDoctor(fixture, "messages", proxy),
      diagnoseDirectly(fixture, "messages", [proxy]),
    ]);
    expect(readiness.json.diagnostics.filter((entry) => entry.area === "provider")).toEqual([
      expect.objectContaining({
        code: OUTBOUND_PROXY_UNREACHABLE_CODE,
        nextCommand: OUTBOUND_PROXY_UNREACHABLE_NEXT_ACTION,
        explanation: expect.stringContaining(EXPECTED.unreachable.explanation),
      }),
    ]);
    expect(direct.outcomes).toEqual([
      expect.objectContaining({
        name: "OutboundProxyRefusal",
        code: OUTBOUND_PROXY_UNREACHABLE_CODE,
        nextAction: OUTBOUND_PROXY_UNREACHABLE_NEXT_ACTION,
        message: expect.stringContaining(EXPECTED.unreachable.explanation),
      }),
    ]);
    await expectIsolatedGuardedProxyDnsRefusal(fixture);
    await expectNothingLeaked(readiness.result, [readiness.ready.root]);
    await expectNothingLeaked(direct.result, [direct.root]);
  });

  it.each(["chat", "messages"] as const)(
    "%s format, diagnose called directly: names each refusal and keeps an unrelated failure generic",
    async (format) => {
      const fixture = await startProxyFixture(roots, closers, "docsfab-proxy-doctor-fixture-");
      fixture.script([
        { kind: "status", status: 403 },
        { kind: "status", status: 407 },
        // Only the chat format reaches this one: a probe request that fails
        // for any reason but a proxy refusal stays the endpoint's own finding.
        ...(format === "chat" ? [{ kind: "status", status: 502 } as const] : []),
      ]);
      const healthy = `http://127.0.0.1:${String(fixture.proxyPort)}`;
      const proxies = [
        proxyFor(fixture, "denied"),
        proxyFor(fixture, "auth-required"),
        ...(format === "chat" ? [proxyFor(fixture, "unreachable"), healthy] : []),
        healthy,
      ];
      const { outcomes, result, root } = await diagnoseDirectly(fixture, format, proxies);
      const named = (kind: Kind) =>
        expect.objectContaining({
          name: "OutboundProxyRefusal",
          code: EXPECTED[kind].code,
          nextAction: EXPECTED[kind].nextAction,
          message: expect.stringContaining(EXPECTED[kind].explanation),
        });
      expect(outcomes).toEqual([
        named("denied"),
        named("auth-required"),
        ...(format === "chat"
          ? [
              named("unreachable"),
              expect.objectContaining({
                name: "EndpointCompatibilityError",
                code: "endpoint-incompatible",
                message: expect.stringContaining("availability failed"),
              }),
            ]
          : []),
        // A healthy tunnel to a target that does not answer the probe as
        // expected is an ordinary live failure, not a proxy code.
        format === "chat"
          ? { passed: true }
          : expect.objectContaining({
              message: "Live model check failed without retaining provider diagnostics.",
              code: "live-model-check-failed",
            }),
      ]);
      if (format === "chat") await expectGuardedProxyDnsRefusal(fixture);
      await expectNothingLeaked(result, [root]);
    },
  );

  it.each(["chat", "messages"] as const)(
    "%s format, readiness path: an invalid setting keeps its configuration diagnostic",
    async (format) => {
      const fixture = await startProxyFixture(roots, closers, "docsfab-proxy-doctor-fixture-");
      const { result, json, ready } = await liveDoctor(
        fixture,
        format,
        "socks5://proxy.example.test:1080",
        { HTTP_PROXY: "ftp://p.example.test:1" },
      );
      expect(result.code).toBe(1);
      expect(json.liveConnectivity.provider).toBe("failed");
      const proxyDiagnostics = json.diagnostics.filter((entry) =>
        entry.code.startsWith("outbound-proxy-"),
      );
      expect(proxyDiagnostics).toEqual([
        expect.objectContaining({
          area: "provider",
          code: OUTBOUND_PROXY_INVALID_CODE,
          nextCommand: OUTBOUND_PROXY_INVALID_NEXT_ACTION,
        }),
        expect.objectContaining({
          area: "configuration",
          code: OUTBOUND_PROXY_INVALID_CODE,
          nextCommand: OUTBOUND_PROXY_INVALID_NEXT_ACTION,
        }),
      ]);
      // Every refused variable is named, not only the one this request used.
      const configuration = proxyDiagnostics.find((entry) => entry.area === "configuration");
      expect(configuration!.explanation).toContain("HTTP_PROXY uses a scheme other than");
      expect(configuration!.explanation).toContain("HTTPS_PROXY names a SOCKS proxy");
      expect(result.stdout).not.toContain("[REDACTED]");
      expect(fixture.proxyConnections()).toBe(0);
      expect(fixture.targetRequests).toEqual([]);
      await expectNothingLeaked(result, [ready.root]);
    },
  );

  it("chat format: a healthy proxy passes the live check on the readiness path", async () => {
    const fixture = await startProxyFixture(roots, closers, "docsfab-proxy-doctor-fixture-");
    const { json } = await liveDoctor(fixture, "chat", fixture.proxyUrl);
    expect(json.liveConnectivity.provider).toBe("passed");
    expect(json.diagnostics.filter((entry) => entry.area === "provider")).toEqual([]);
    expect(fixture.targetRequests.map((request) => request.url)).toContain("/v1/chat/completions");
  });

  it("messages format: an unrelated live failure still reads provider-live-unavailable", async () => {
    const fixture = await startProxyFixture(roots, closers, "docsfab-proxy-doctor-fixture-");
    const { json } = await liveDoctor(fixture, "messages", fixture.proxyUrl);
    expect(json.liveConnectivity.provider).toBe("failed");
    expect(json.diagnostics.filter((entry) => entry.area === "provider")).toEqual([
      expect.objectContaining({ code: "provider-live-unavailable" }),
    ]);
    // No proxy code stands in for the provider's own failure in any area.
    expect(json.diagnostics.filter((entry) => entry.code.startsWith("outbound-proxy-"))).toEqual(
      [],
    );
    // Pi's Anthropic SDK posts to the beta path; the send gate admits it.
    expect(fixture.targetRequests.map((request) => request.url)).toContain(
      "/v1/messages?beta=true",
    );
  });

  it("offline doctor opens no connection to the proxy", async () => {
    const fixture = await startProxyFixture(roots, closers, "docsfab-proxy-doctor-fixture-");
    const ready = await readyRepository();
    const result = await runGuardedNode(
      fixture,
      [...LAUNCHER, "doctor", "--repo", ready.repository, "--json"],
      childEnvironment(fixture, {
        ...modelEnvironment("chat"),
        ...ready.environment,
        HTTPS_PROXY: fixture.proxyUrl,
      }),
      processDeadline(),
    );
    expect((JSON.parse(result.stdout) as DoctorJson).liveConnectivity.provider).toBe(
      "not-requested",
    );
    expect(fixture.proxyConnections()).toBe(0);
  });
});
