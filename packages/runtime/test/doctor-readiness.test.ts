// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { DocsFabConfig } from "../src/config/runtime-loader.js";
import {
  formatDoctorReadiness,
  inspectDoctorReadiness,
  reinstallAction,
  type DoctorReadinessCommandRunner,
  type DoctorReadinessResult,
} from "../src/doctor-readiness.js";
import { unobservedDraftMrReadiness } from "../src/doctor-publication-readiness.js";
import { initHelp, usage } from "../src/cli/usage.js";
import { renderDoctorPresentation } from "../src/cli/doctor-presentation.js";
import { resolveDocsFabPrivateRoots } from "../src/init.js";
import { formatCheckGrid, formatSectionHeader } from "../src/operator/cli-format.js";
import { remediationText } from "../src/operator/remediation.js";
import {
  observeGitLabTargetResponse,
  withoutGitConfigFlags,
} from "./gitlab-target-observation-fake.js";
import {
  EndpointCompatibilityError,
  probeEndpointCompatibility,
} from "../src/profile/endpoint-compatibility.js";
import {
  INSECURE_MODEL_ENDPOINT_CODE,
  INSECURE_MODEL_ENDPOINT_NEXT_ACTION,
  InsecureModelEndpointError,
  LOCALHOST_RESOLUTION_MESSAGE,
} from "../src/model/endpoint-transport.js";
import { limit } from "../src/config/limits.js";
import {
  OUTBOUND_PROXY_DENIED_CODE,
  OUTBOUND_PROXY_INVALID_CODE,
  OUTBOUND_PROXY_INVALID_NEXT_ACTION,
  OUTBOUND_PROXY_NOT_ENABLED_CODE,
  OUTBOUND_PROXY_NOT_ENABLED_NEXT_ACTION,
  OutboundProxyRefusal,
  outboundFetch,
  resetOutboundProxyStateForTests,
  type ProxyRuntime,
} from "../src/model/outbound-http-policy.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../src/json-evidence.js";
import { validModelConfig } from "./helpers.js";
import {
  ECHO_KEYS,
  ECHO_SHAPES,
  ECHO_TRANSPORTS,
  expectNoCredentialRun,
  startEchoServer,
  type EchoServer,
} from "./helpers/credential-echo.js";
import {
  fixtureFetch,
  loadEndpointFixture,
  type EndpointFixtureName,
} from "./helpers/endpoint-compatibility-fixtures.js";
import { temporaryRoots } from "./helpers/temp.js";

const roots = temporaryRoots();

class FakeCommands implements DoctorReadinessCommandRunner {
  readonly calls: string[] = [];
  readonly probeCalls: string[] = [];
  constructor(
    private readonly repository: string,
    private readonly overrides: Readonly<
      Record<string, { exitCode: number; stdout: string; stderr?: string }>
    > = {},
    private readonly credentialProbes: Readonly<
      Record<string, "present" | "missing" | "unverified">
    > = {},
  ) {}

  async run(
    command: "git" | "glab" | "npm",
    args: readonly string[],
  ): Promise<{ exitCode: number; stdout: string; stderr?: string }> {
    const key = `${command} ${withoutGitConfigFlags(args).join(" ")}`;
    this.calls.push(key);
    if (this.overrides[key]) return this.overrides[key]!;
    if (
      key.startsWith("glab api --hostname gitlab.example.test ") &&
      this.overrides["glab api --hostname gitlab.example.test"]
    ) {
      return this.overrides["glab api --hostname gitlab.example.test"]!;
    }
    const observed = observeGitLabTargetResponse(key, {
      host: "gitlab.example.test",
      projectPath: "group/project",
      projectId: 7,
      branch: "main",
      revision: "a".repeat(40),
    });
    if (observed) return observed;
    const defaults: Record<string, { exitCode: number; stdout: string }> = {
      "git --version": { exitCode: 0, stdout: "git version 2.50.0\n" },
      "git rev-parse --show-toplevel": {
        exitCode: 0,
        stdout: `${this.repository}\n`,
      },
      "git symbolic-ref --quiet --short HEAD": {
        exitCode: 0,
        stdout: "main\n",
      },
      "git rev-parse --verify HEAD^{commit}": {
        exitCode: 0,
        stdout: `${"a".repeat(40)}\n`,
      },
      [`git cat-file -e ${"a".repeat(40)}^{commit}`]: {
        exitCode: 0,
        stdout: "",
      },
      "git config --get user.name": { exitCode: 0, stdout: "Operator\n" },
      "git config --get user.email": {
        exitCode: 0,
        stdout: "operator@example.test\n",
      },
      "git ls-tree --name-only HEAD -- .docsfab.json": {
        exitCode: 0,
        stdout: ".docsfab.json\n",
      },
      "git status --porcelain=v1 --untracked-files=all": {
        exitCode: 0,
        stdout: "",
      },
      "git remote get-url --all origin": {
        exitCode: 0,
        stdout: "https://gitlab.example.test/group/project.git\n",
      },
      "glab --version": { exitCode: 0, stdout: "glab 1.0\n" },
      "glab config get host": { exitCode: 0, stdout: "gitlab.com\n" },
      "glab config get token --host gitlab.example.test": { exitCode: 0, stdout: "" },
      "glab auth status --hostname gitlab.example.test": {
        exitCode: 0,
        stdout: "authenticated\n",
      },
      "npm --version": { exitCode: 0, stdout: "11.0.0\n" },
    };
    return defaults[key] ?? { exitCode: 1, stdout: "" };
  }

  async probeCredential(
    command: "glab",
    args: readonly string[],
  ): Promise<"present" | "missing" | "unverified"> {
    const key = `${command} ${args.join(" ")}`;
    this.probeCalls.push(key);
    return this.credentialProbes[key] ?? "present";
  }
}

describe("actionable doctor readiness", () => {
  it("reports required-check isolation as a named nonblocking limitation with a next action", async () => {
    const fixture = await readyFixture();
    await writeFile(
      resolve(fixture.repository, "AGENTS.md"),
      "Run `npm test` before proposing a documentation change.\n",
    );
    execFileSync("git", ["add", "AGENTS.md"], { cwd: fixture.repository });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Doctor Test",
        "-c",
        "user.email=doctor@example.test",
        "commit",
        "-qm",
        "require check",
      ],
      { cwd: fixture.repository },
    );
    const probeRequiredCheckReadiness = vi.fn(async () => ({
      code: "required-check-isolation-unavailable" as const,
      explanation: "A repository-required check cannot run on this host.",
      nextCommand: "Enable the isolated check backend, then rerun doctor.",
    }));
    const options = {
      cwd: fixture.repository,
      environment: fixture.environment,
      homeDirectory: fixture.home,
      commands: new FakeCommands(fixture.repository),
      platform: "darwin" as const,
      loadConfiguration: () => fixture.config,
      validateConfiguration: async () => undefined,
      probeRequiredCheckReadiness,
    };
    const unavailable = await inspectDoctorReadiness(options);
    expect(probeRequiredCheckReadiness).toHaveBeenCalledOnce();
    expect(unavailable.status).toBe("ready");
    expect(unavailable.validationScope).toEqual({
      readiness: "prerequisites-only",
      deliveryConfinement: "not-checked",
    });
    expect(unavailable.limitations).toEqual([
      expect.objectContaining({ code: "native-lint-platform-unavailable" }),
      expect.objectContaining({ code: "required-check-isolation-unavailable" }),
    ]);
    expect(formatDoctorReadiness(unavailable)).toContain(
      "LIMITATION required-check-isolation-unavailable:",
    );
    expect(formatDoctorReadiness(unavailable)).toContain(
      "Next action: Enable the isolated check backend",
    );

    probeRequiredCheckReadiness.mockResolvedValueOnce(undefined as never);
    const available = await inspectDoctorReadiness(options);
    expect(available.limitations).toEqual([
      expect.objectContaining({ code: "native-lint-platform-unavailable" }),
    ]);
    expect(available.status).toBe("ready");
  });

  it("names the installed package.json version in the reinstall remediation", async () => {
    const { version } = JSON.parse(await readFile(resolve("package.json"), "utf8")) as {
      version: string;
    };
    // The exact release tarball, with lifecycle scripts off; never a registry name.
    expect(reinstallAction()).toContain(
      `Reinstall DocsFab ${version} from its exact release tarball`,
    );
    expect(reinstallAction()).toContain("npm i -g --ignore-scripts");
    expect(reinstallAction()).not.toContain("docsfab@");
  });

  it("reports every readiness layer and the exact ready auto modes without connectivity", async () => {
    const fixture = await readyFixture();
    const commands = new FakeCommands(fixture.repository);
    const probeRequiredCheckReadiness = vi.fn(async () => undefined);
    const result = await inspectDoctorReadiness({
      cwd: fixture.repository,
      environment: fixture.environment,
      homeDirectory: fixture.home,
      commands,
      loadConfiguration: () => fixture.config,
      validateConfiguration: async () => undefined,
      probeRequiredCheckReadiness,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.status).toBe("ready");
    expect(result.liveConnectivity).toEqual({
      requested: false,
      provider: "not-requested",
      gitlab: "not-requested",
    });
    expect(result.repositoryRevision).toBe("a".repeat(40));
    expect(result.checks.map((check) => check.area)).toEqual([
      "installation",
      "configuration",
      "repository",
      "provider",
      "validation",
    ]);
    expect(result.useReadiness["draft-mr"].checks.map((check) => check.area)).toEqual([
      "installation",
      "configuration",
      "repository",
      "provider",
      "gitlab",
      "private-state",
      "validation",
    ]);
    expect(result.useReadiness["draft-mr"].status).toBe("blocked");
    expect(result.useReadiness["draft-mr"].diagnostics.map((item) => item.code)).toContain(
      "gitlab-target-not-observed",
    );
    expect(result.validationCommand).toBeNull();
    expect(result.validationScope).toEqual({
      readiness: "prerequisites-only",
      deliveryConfinement: "not-checked",
    });
    expect(probeRequiredCheckReadiness).not.toHaveBeenCalled();
    for (const detail of ["normal", "quiet", "verbose"] as const) {
      const output = renderDoctorPresentation({ readiness: result, detail }).stdout;
      expect(output).toContain("ready for local-review");
      expect(output).toContain("Validation scope: prerequisites only");
      expect(output).toContain("Delivery confinement: not checked");
    }
    expect(formatDoctorReadiness(result)).toContain("Delivery confinement: not checked");
    expect(commands.calls).not.toContain("npm --version");
    expect(result.autoModesReady).toEqual(["dry-run", "patch-only"]);
    expect(commands.calls).not.toContain("glab auth status --hostname gitlab.example.test");
    expect(commands.calls).not.toContain("glab config get host");
    expect(formatDoctorReadiness(result).endsWith("NEXT docsfab list")).toBe(true);
    expect([...formatDoctorReadiness(result).matchAll(/NEXT docsfab list/gu)]).toHaveLength(1);
  });

  it("preserves actual prerequisite scope in ready and blocked command JSON", async () => {
    const fixture = await readyFixture();
    const probeRequiredCheckReadiness = vi.fn(async () => undefined);
    const options = {
      cwd: fixture.repository,
      environment: fixture.environment,
      homeDirectory: fixture.home,
      commands: new FakeCommands(fixture.repository),
      loadConfiguration: () => fixture.config,
      validateConfiguration: async () => undefined,
      probeRequiredCheckReadiness,
    };
    const ready = await inspectDoctorReadiness(options);
    const blocked = await inspectDoctorReadiness({
      ...options,
      loadConfiguration: () => {
        throw new Error("fixture configuration unavailable");
      },
    });
    expect(ready.status).toBe("ready");
    expect(blocked.status).toBe("blocked");
    const readinessModule = await import("../src/doctor-readiness.js");
    const inspect = vi.spyOn(readinessModule, "inspectDoctorReadiness");
    const logs: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
      logs.push(String(message ?? ""));
    });
    const previousExitCode = process.exitCode;
    try {
      const { handleDoctorCommand } = await import("../src/cli/commands/doctor.js");
      for (const result of [ready, blocked]) {
        logs.length = 0;
        process.exitCode = undefined;
        inspect.mockResolvedValueOnce(result);
        await handleDoctorCommand(["--repo", fixture.repository, "--json"]);
        expect(logs).toHaveLength(1);
        const record = JSON.parse(logs[0]!) as DoctorReadinessResult;
        expect(record).toEqual(result);
        expect(record.validationScope).toEqual({
          readiness: "prerequisites-only",
          deliveryConfinement: "not-checked",
        });
        expect(process.exitCode).toBe(result.status === "blocked" ? 1 : undefined);
      }
      expect(probeRequiredCheckReadiness).not.toHaveBeenCalled();
    } finally {
      inspect.mockRestore();
      log.mockRestore();
      process.exitCode = previousExitCode;
    }
  });

  it.each<[string, Partial<ProxyRuntime>, NodeJS.ProcessEnv, string[], string]>([
    [
      "a Node without proxy support blocks configuration while a proxy is set",
      {},
      { HTTPS_PROXY: "http://proxy.example.test:3128" },
      ["outbound-proxy-not-enabled"],
      "Built-in proxy support: unsupported by this Node.js release",
    ],
    [
      "a Node with proxy support reports none",
      { setGlobalProxyFromEnv: () => () => undefined },
      { HTTPS_PROXY: "http://proxy.example.test:3128" },
      [],
      "Built-in proxy support: available",
    ],
    [
      "a Node without proxy support and no proxy variable reports none",
      {},
      {},
      [],
      "Built-in proxy support: unsupported by this Node.js release",
    ],
    [
      "a Node started with --use-env-proxy reports none",
      { execArgv: ["--use-env-proxy"] },
      { HTTPS_PROXY: "http://proxy.example.test:3128" },
      [],
      "Built-in proxy support: on (Node started with proxy support)",
    ],
    [
      "an invalid proxy on a Node without proxy support reports only the invalid setting",
      {},
      { HTTPS_PROXY: "socks5://proxy.example.test:1080" },
      ["outbound-proxy-invalid"],
      "Built-in proxy support: unsupported by this Node.js release",
    ],
  ])(
    "offline doctor proxy capability: %s",
    async (_name, runtime, proxyEnv, codes, supportLine) => {
      const fixture = await readyFixture();
      const proxyRuntime: ProxyRuntime = {
        setGlobalProxyFromEnv: undefined,
        execArgv: [],
        nodeOptions: undefined,
        nodeUseEnvProxy: undefined,
        ...runtime,
      };
      // The same inspection init runs for its readiness grid, with the seam set.
      const result = await inspectDoctorReadiness({
        cwd: fixture.repository,
        environment: { ...fixture.environment, ...proxyEnv },
        homeDirectory: fixture.home,
        commands: new FakeCommands(fixture.repository),
        loadConfiguration: () => fixture.config,
        validateConfiguration: async () => undefined,
        proxyRuntime,
      });
      expect(result.diagnostics.map((item) => [item.area, item.code])).toEqual(
        codes.map((code) => ["configuration", code]),
      );
      expect(result.checks).toContainEqual({
        area: "configuration",
        status: codes.length > 0 ? "blocked" : "ready",
      });
      expect(formatDoctorReadiness(result)).toContain(supportLine);
    },
  );

  describe("doctor --live with a proxy refusal", () => {
    const supportedNode: ProxyRuntime = {
      setGlobalProxyFromEnv: () => () => undefined,
      execArgv: [],
      nodeOptions: undefined,
      nodeUseEnvProxy: undefined,
    };
    const unsupportedNode: ProxyRuntime = { ...supportedNode, setGlobalProxyFromEnv: undefined };
    const target = "https://models.example.test/v1/chat/completions";

    afterEach(() => {
      resetOutboundProxyStateForTests();
    });

    /** The refusal the shipped default fetch throws for this environment and Node. */
    async function liveRefusal(
      proxyEnv: NodeJS.ProcessEnv,
      runtime: ProxyRuntime,
    ): Promise<OutboundProxyRefusal> {
      resetOutboundProxyStateForTests();
      const error = await outboundFetch({ env: proxyEnv, runtime })(target).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(OutboundProxyRefusal);
      return error as OutboundProxyRefusal;
    }

    async function liveDoctor(
      proxyEnv: NodeJS.ProcessEnv,
      runtime: ProxyRuntime,
      refusal: OutboundProxyRefusal,
    ): Promise<DoctorReadinessResult> {
      const fixture = await readyFixture();
      return inspectDoctorReadiness({
        cwd: fixture.repository,
        environment: { ...fixture.environment, ...proxyEnv },
        homeDirectory: fixture.home,
        commands: new FakeCommands(fixture.repository),
        live: true,
        loadConfiguration: () => fixture.config,
        validateConfiguration: async () => undefined,
        proxyRuntime: runtime,
        checkProviderConnectivity: async () => {
          throw refusal;
        },
      });
    }

    it("keeps the configuration diagnostic for an invalid setting and lists every variable", async () => {
      const proxyEnv = {
        HTTPS_PROXY: "socks5://proxy.example.test:1080",
        HTTP_PROXY: "ftp://p.example.test:1",
      };
      const refusal = await liveRefusal(proxyEnv, supportedNode);
      expect(refusal.code).toBe(OUTBOUND_PROXY_INVALID_CODE);
      const result = await liveDoctor(proxyEnv, supportedNode, refusal);
      expect(result.liveConnectivity.provider).toBe("failed");
      expect(result.diagnostics.map((item) => [item.area, item.code])).toEqual([
        ["provider", OUTBOUND_PROXY_INVALID_CODE],
        ["configuration", OUTBOUND_PROXY_INVALID_CODE],
      ]);
      const configuration = result.diagnostics.find((item) => item.area === "configuration");
      expect(configuration!.explanation).toContain("HTTP_PROXY uses a scheme other than");
      expect(configuration!.explanation).toContain("HTTPS_PROXY names a SOCKS proxy");
      expect(configuration!.nextCommand).toBe(OUTBOUND_PROXY_INVALID_NEXT_ACTION);
      expect(result.checks).toEqual(
        expect.arrayContaining([
          { area: "configuration", status: "blocked" },
          { area: "provider", status: "blocked" },
        ]),
      );
      expect(JSON.stringify(result)).not.toContain("[REDACTED]");
      expect(formatDoctorReadiness(result)).not.toContain("[REDACTED]");
    });

    it("keeps the configuration diagnostic for a Node without proxy support", async () => {
      const proxyEnv = { HTTPS_PROXY: "http://proxy.example.test:3128" };
      const refusal = await liveRefusal(proxyEnv, unsupportedNode);
      expect(refusal.code).toBe(OUTBOUND_PROXY_NOT_ENABLED_CODE);
      const result = await liveDoctor(proxyEnv, unsupportedNode, refusal);
      expect(result.liveConnectivity.provider).toBe("failed");
      expect(result.diagnostics.map((item) => [item.area, item.code])).toEqual([
        ["provider", OUTBOUND_PROXY_NOT_ENABLED_CODE],
        ["configuration", OUTBOUND_PROXY_NOT_ENABLED_CODE],
      ]);
      expect(result.checks).toContainEqual({ area: "provider", status: "blocked" });
    });

    it("names a refusal no configuration diagnostic reports under provider", async () => {
      // Proxy support exists but is not turned on in this process: the
      // environment alone reports nothing, so the live refusal is the finding.
      const proxyEnv = { HTTPS_PROXY: "http://proxy.example.test:3128" };
      const refusal = await liveRefusal(proxyEnv, supportedNode);
      expect(refusal.code).toBe(OUTBOUND_PROXY_NOT_ENABLED_CODE);
      const result = await liveDoctor(proxyEnv, supportedNode, refusal);
      expect(result.liveConnectivity.provider).toBe("failed");
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          area: "provider",
          code: OUTBOUND_PROXY_NOT_ENABLED_CODE,
          nextCommand: OUTBOUND_PROXY_NOT_ENABLED_NEXT_ACTION,
        }),
      ]);
      expect(result.checks).toContainEqual({ area: "configuration", status: "ready" });
    });

    it("names a proxy failure under provider beside a configuration diagnostic with another code", async () => {
      // An invalid HTTP_PROXY does not stop an HTTPS request through a valid
      // HTTPS_PROXY; that proxy's own refusal is still the provider's finding.
      const proxyEnv = {
        HTTPS_PROXY: "http://proxy.example.test:3128",
        HTTP_PROXY: "ftp://p.example.test:1",
      };
      const refusal = new OutboundProxyRefusal(
        "denied",
        `The HTTPS_PROXY proxy refused to open a tunnel to models.example.test with HTTP 403 (${OUTBOUND_PROXY_DENIED_CODE}). Nothing was sent to models.example.test.`,
        "HTTPS_PROXY",
      );
      const result = await liveDoctor(proxyEnv, supportedNode, refusal);
      expect(result.diagnostics.map((item) => [item.area, item.code])).toEqual([
        ["provider", OUTBOUND_PROXY_DENIED_CODE],
        ["configuration", OUTBOUND_PROXY_INVALID_CODE],
      ]);
    });
  });

  it("treats a per-host token as GitLab-ready when the default glab host differs", async () => {
    const fixture = await readyFixture();
    const commands = new FakeCommands(fixture.repository, {
      "glab config get host": { exitCode: 0, stdout: "gitlab.com\n" },
    });
    const result = await inspectDoctorReadiness({
      cwd: fixture.repository,
      environment: fixture.environment,
      homeDirectory: fixture.home,
      commands,
      loadConfiguration: () => fixture.config,
      validateConfiguration: async () => undefined,
    });
    expect(result.diagnostics.map((item) => item.code)).not.toContain("gitlab-login-unverified");
    expect(result.useReadiness["draft-mr"].diagnostics.map((item) => item.code)).not.toContain(
      "gitlab-login-unverified",
    );
    expect(result.useReadiness["draft-mr"].diagnostics.map((item) => item.code)).toContain(
      "gitlab-target-not-observed",
    );
    expect(result.autoModesReady).toEqual(["dry-run", "patch-only"]);
  });

  it("advises, without blocking, when pages sit outside every recognized documentation directory", async () => {
    const fixture = await readyFixture();
    await mkdir(resolve(fixture.repository, "get-started"));
    await writeFile(resolve(fixture.repository, "get-started", "install.mdx"), "Install.\n");
    const inspect = () =>
      inspectDoctorReadiness({
        cwd: fixture.repository,
        environment: fixture.environment,
        homeDirectory: fixture.home,
        commands: new FakeCommands(fixture.repository),
        loadConfiguration: () => fixture.config,
        validateConfiguration: async () => undefined,
      });
    const result = await inspect();
    const advisory = result.diagnostics.find(
      (item) => item.code === "documentation-layout-unrecognized",
    );
    expect(advisory).toMatchObject({ area: "repository" });
    expect(advisory?.explanation).toContain(
      "text documents in get-started/ (1 document) are read-only",
    );
    expect(advisory?.nextCommand).toContain("Recommended: keep documentation under docs/");
    expect(advisory?.nextCommand).toContain('"documentationRoots": ["get-started"]');
    expect(advisory?.nextCommand).toContain("docsfab live-agent --docs-dir get-started.");
    expect(result.checks).toContainEqual({ area: "repository", status: "ready" });
    expect(result.status).toBe("ready");
    expect(formatDoctorReadiness(result)).toContain("Code: documentation-layout-unrecognized");
    // Committed roots are a recognized layout; working edits alone do not grant them.
    await writeFile(
      resolve(fixture.repository, ".docsfab.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        gitlab: { remote: "origin", defaultBranch: "main" },
        provider: { configuration: "host" },
        storage: { scope: "user-private" },
        documentationRoots: ["get-started"],
      })}\n`,
      { mode: 0o600 },
    );
    expect((await inspect()).diagnostics.map((item) => item.code)).toContain(
      "documentation-layout-unrecognized",
    );
    execFileSync("git", ["add", ".docsfab.json"], { cwd: fixture.repository });
    execFileSync(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "user.name=Doctor Test",
        "-c",
        "user.email=doctor@example.test",
        "commit",
        "-qm",
        "grant documentation root",
      ],
      { cwd: fixture.repository },
    );
    expect((await inspect()).diagnostics.map((item) => item.code)).not.toContain(
      "documentation-layout-unrecognized",
    );
  });

  it("keeps missing credentials, GitLab login, and Git identity distinct", async () => {
    const fixture = await readyFixture();
    const canary = `nvapi-${"S".repeat(32)}`;
    const commands = new FakeCommands(
      fixture.repository,
      {
        "git config --get user.name": { exitCode: 1, stdout: canary },
      },
      {
        "glab config get token --host gitlab.example.test": "missing",
      },
    );
    const result = await inspectDoctorReadiness({
      cwd: fixture.repository,
      environment: fixture.environment,
      homeDirectory: fixture.home,
      commands,
      loadConfiguration: () => {
        throw { issues: [{ field: "MODEL_API_KEY" }] };
      },
      validateConfiguration: async () => undefined,
    });

    expect(result.useReadiness["draft-mr"].diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        "git-identity-missing",
        "provider-credentials-missing",
        "gitlab-login-missing",
      ]),
    );
    for (const item of result.useReadiness["draft-mr"].diagnostics) {
      expect(item.explanation).toBeTruthy();
      expect(item.nextCommand).toBeTruthy();
    }
    const output = formatDoctorReadiness(result);
    expect(output).not.toContain(canary);
    expect(output).toContain(`Evaluated repository: ${fixture.repository}`);
    expect(result.autoModesReady).toEqual([]);
  });

  it.each(["malformed package metadata", "symlinked package metadata"] as const)(
    "ignores %s and defers run-specific validation",
    async (metadataKind) => {
      const fixture = await readyFixture();
      const packagePath = resolve(fixture.repository, "package.json");
      await rm(packagePath);
      if (metadataKind === "malformed package metadata") {
        await writeFile(packagePath, "{ malformed", { mode: 0o600 });
      } else {
        const target = resolve(fixture.root, "package-target.json");
        await writeFile(target, JSON.stringify({ scripts: { check: "echo unsafe" } }), {
          mode: 0o600,
        });
        await symlink(target, packagePath);
      }
      const commands = new FakeCommands(fixture.repository, {
        "npm --version": { exitCode: 1, stdout: `npm-${"S".repeat(32)}` },
      });
      const result = await inspectDoctorReadiness({
        cwd: fixture.repository,
        environment: fixture.environment,
        homeDirectory: fixture.home,
        commands,
        loadConfiguration: () => fixture.config,
        validateConfiguration: async () => undefined,
      });

      expect(result.status).toBe("ready");
      expect(result.validationCommand).toBeNull();
      expect(result.diagnostics).toEqual([]);
      expect(commands.calls).not.toContain("npm --version");
    },
  );

  it("performs GitLab API observation only in explicit live mode", async () => {
    const fixture = await readyFixture();
    const commands = new FakeCommands(fixture.repository, {
      "glab api --hostname gitlab.example.test": {
        exitCode: 1,
        stdout: "private raw output",
      },
    });
    const result = await inspectDoctorReadiness({
      cwd: fixture.repository,
      environment: fixture.environment,
      homeDirectory: fixture.home,
      commands,
      live: true,
      use: "draft-mr",
      loadConfiguration: () => fixture.config,
      validateConfiguration: async () => undefined,
      checkProviderConnectivity: async () => undefined,
    });
    expect(
      commands.calls.some((call) => call.startsWith("glab api --hostname gitlab.example.test ")),
    ).toBe(true);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "gitlab-live-unavailable" }),
    );
    expect(result.liveConnectivity).toEqual({
      requested: true,
      provider: "passed",
      gitlab: "failed",
    });
    expect(formatDoctorReadiness(result)).not.toContain("private raw output");
    expect(formatDoctorReadiness(result)).not.toMatch(/glab auth login/iu);
  });

  it("maps live connection-reset to gitlab-live-unavailable without a login NEXT", async () => {
    const fixture = await readyFixture();
    const commands = new FakeCommands(fixture.repository, {
      "glab api --hostname gitlab.example.test": {
        exitCode: 1,
        stdout: "",
        stderr:
          'Error using API: Get "https://gitlab.example.test/api/v4/user": connection reset by peer',
      },
    });
    const result = await inspectDoctorReadiness({
      cwd: fixture.repository,
      environment: fixture.environment,
      homeDirectory: fixture.home,
      commands,
      live: true,
      use: "draft-mr",
      loadConfiguration: () => fixture.config,
      validateConfiguration: async () => undefined,
      checkProviderConnectivity: async () => undefined,
    });
    const printed = formatDoctorReadiness(result);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "gitlab-live-unavailable" }),
    );
    expect(printed).toContain("unreachable");
    expect(printed).not.toMatch(/glab auth login/iu);
    expect(printed).not.toContain("gitlab.example.test/api");
  });

  it("marks each requested live boundary only after that boundary passes", async () => {
    const fixture = await readyFixture();
    const result = await inspectDoctorReadiness({
      cwd: fixture.repository,
      environment: fixture.environment,
      homeDirectory: fixture.home,
      commands: new FakeCommands(fixture.repository),
      live: true,
      loadConfiguration: () => fixture.config,
      validateConfiguration: async () => undefined,
      checkProviderConnectivity: async () => {
        throw new Error("raw provider output");
      },
    });
    expect(result.liveConnectivity).toEqual({
      requested: true,
      provider: "failed",
      gitlab: "passed",
    });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "provider-live-unavailable" }),
    );
    expect(formatDoctorReadiness(result)).not.toContain("raw provider output");
  });

  describe("endpoint compatibility", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    async function refusal(name: EndpointFixtureName): Promise<EndpointCompatibilityError> {
      const fixture = loadEndpointFixture(name);
      vi.stubGlobal("fetch", fixtureFetch(fixture).fetch);
      const report = await probeEndpointCompatibility({
        modelId: fixture.model,
        baseUrl: "https://integrate.api.nvidia.com/v1",
        apiKey: validModelConfig.apiKey,
        maxOutputTokens: fixture.maxOutputTokens ?? 4096,
        outputLimitSource: "configured",
        shape: { tokenField: "max_tokens", systemRole: "system", store: false },
      });
      return new EndpointCompatibilityError(report);
    }

    async function liveDoctor(error: unknown) {
      const fixture = await readyFixture();
      return inspectDoctorReadiness({
        cwd: fixture.repository,
        environment: fixture.environment,
        homeDirectory: fixture.home,
        commands: new FakeCommands(fixture.repository),
        live: true,
        loadConfiguration: () => fixture.config,
        validateConfiguration: async () => undefined,
        checkProviderConnectivity: async () => {
          throw error;
        },
      });
    }

    it("names the provider's end-of-life notice and the reselect command", async () => {
      const result = await liveDoctor(await refusal("nano-end-of-life-410"));
      expect(result.status).toBe("blocked");
      expect(result.liveConnectivity.provider).toBe("failed");
      expect(result.endpointCompatibility?.verdict).toBe("incompatible");
      const diagnostic = result.diagnostics.find((entry) => entry.area === "provider");
      expect(diagnostic).toMatchObject({ code: "endpoint-incompatible" });
      expect(diagnostic?.explanation).toContain(
        "has reached its end of life on 2026-09-01T09:00:00Z",
      );
      expect(diagnostic?.explanation).toContain("Owner: operator-configuration.");
      expect(diagnostic?.nextCommand).toContain("docsfab setup --profile <composition-id>");
      const printed = formatDoctorReadiness(result);
      expect(printed).toContain("Endpoint compatibility: incompatible");
      expect(printed).toContain("availability: fail (end-of-life)");
      expect(printed).not.toContain("no body");
    });

    it("names the output limit when a reply is cut before the tool call", async () => {
      const result = await liveDoctor(await refusal("lightning-length-cut"));
      const diagnostic = result.diagnostics.find((entry) => entry.area === "provider");
      expect(diagnostic).toMatchObject({ code: "endpoint-incompatible" });
      expect(diagnostic?.explanation).toContain("output-limit failed (length-cut)");
      expect(diagnostic?.nextCommand).toContain("MODEL_MAX_OUTPUT_TOKENS above 1024");
    });

    it("keeps an in-stream capacity refusal on the transient provider code", async () => {
      const result = await liveDoctor(await refusal("super-stream-error-503"));
      const diagnostic = result.diagnostics.find((entry) => entry.area === "provider");
      expect(diagnostic).toMatchObject({ code: "provider-live-unavailable" });
      expect(diagnostic?.explanation).toContain('Provider said: "Service temporarily overloaded"');
      expect(diagnostic?.nextCommand).toBe(
        "Wait for provider capacity, then rerun the probe with --live.",
      );
    });

    it("keeps the insecure-endpoint code from the live check", async () => {
      const result = await liveDoctor(new InsecureModelEndpointError(LOCALHOST_RESOLUTION_MESSAGE));
      expect(result.liveConnectivity.provider).toBe("failed");
      expect(result.diagnostics.find((entry) => entry.area === "provider")).toMatchObject({
        code: INSECURE_MODEL_ENDPOINT_CODE,
        nextCommand: INSECURE_MODEL_ENDPOINT_NEXT_ACTION,
      });
    });

    describe("against a provider that echoes part of the key", () => {
      let server: EchoServer;
      beforeAll(async () => {
        server = await startEchoServer();
      });
      afterAll(async () => {
        await server.close();
      });

      const cases = ECHO_KEYS.flatMap(([keyLabel, key]) =>
        Object.entries(ECHO_SHAPES).flatMap(([shapeLabel, shape]) =>
          ECHO_TRANSPORTS.map(
            (transport) => [keyLabel, shapeLabel, transport, key, shape] as const,
          ),
        ),
      );

      // The shipped live check: diagnose probes the configured loopback endpoint.
      it.each(cases)(
        "never prints %s from %s (%s)",
        async (_keyLabel, _shapeLabel, transport, key, shape) => {
          server.serve(transport, shape.message(key));
          const fixture = await readyFixture();
          const result = await inspectDoctorReadiness({
            cwd: fixture.repository,
            environment: fixture.environment,
            homeDirectory: fixture.home,
            commands: new FakeCommands(fixture.repository),
            live: true,
            loadConfiguration: () => ({
              ...fixture.config,
              model: { ...validModelConfig, baseUrl: server.baseUrl, apiKey: key },
            }),
            validateConfiguration: async () => undefined,
          });
          expect(result.liveConnectivity.provider).toBe("failed");
          const quoted = result.endpointCompatibility?.checks.find(
            (check) => check.status === "fail",
          );
          expect(quoted?.providerMessage).toContain(shape.kept);
          const printed = formatDoctorReadiness(result);
          expect(printed).toContain('Provider said: "');
          // `doctor --live --json` prints this record.
          const record = canonicalizeJsonEvidence(result as unknown as JsonEvidenceValue);
          expectNoCredentialRun(
            [printed],
            key,
            limit("endpointProbe.credentialEchoMinChars").value,
            [record],
          );
        },
      );
    });

    it("records a passing verdict from the live check", async () => {
      const fixture = await readyFixture();
      const compatibility = {
        schemaVersion: 1,
        kind: "docsfab-endpoint-compatibility",
        verdict: "compatible",
        maxOutputTokens: 8192,
        checks: [],
      } as const;
      const result = await inspectDoctorReadiness({
        cwd: fixture.repository,
        environment: fixture.environment,
        homeDirectory: fixture.home,
        commands: new FakeCommands(fixture.repository),
        live: true,
        loadConfiguration: () => fixture.config,
        validateConfiguration: async () => undefined,
        checkProviderConnectivity: async () => ({ live: { latencyMs: 5, compatibility } }),
      });
      expect(result.liveConnectivity.provider).toBe("passed");
      expect(result.endpointCompatibility).toEqual(compatibility);
    });
  });

  it("does not attempt either live boundary before offline readiness passes", async () => {
    const fixture = await readyFixture();
    let providerCalls = 0;
    const commands = new FakeCommands(fixture.repository, {
      "git rev-parse --show-toplevel": { exitCode: 1, stdout: "" },
    });
    const result = await inspectDoctorReadiness({
      cwd: fixture.repository,
      environment: fixture.environment,
      homeDirectory: fixture.home,
      commands,
      live: true,
      loadConfiguration: () => fixture.config,
      validateConfiguration: async () => undefined,
      checkProviderConnectivity: async () => {
        providerCalls += 1;
      },
    });
    expect(providerCalls).toBe(0);
    expect(commands.calls.some((call) => call.startsWith("glab auth status"))).toBe(false);
    expect(result.liveConnectivity).toEqual({
      requested: true,
      provider: "not-attempted",
      gitlab: "not-attempted",
    });
  });

  it("distinguishes an unattached repository without exposing the attempted path", async () => {
    const fixture = await readyFixture();
    const commands = new FakeCommands(fixture.repository, {
      "git rev-parse --show-toplevel": {
        exitCode: 1,
        stdout: "/private/host/path",
      },
    });
    const result = await inspectDoctorReadiness({
      cwd: fixture.repository,
      environment: fixture.environment,
      homeDirectory: fixture.home,
      commands,
      loadConfiguration: () => fixture.config,
      validateConfiguration: async () => undefined,
    });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "repository-unattached" }),
    );
    expect(formatDoctorReadiness(result)).not.toContain("/private/host/path");
  });

  it("keeps missing Git and glab runtimes as separate closed diagnostics", async () => {
    const fixture = await readyFixture();
    const missingGit = await inspectDoctorReadiness({
      cwd: fixture.repository,
      environment: fixture.environment,
      homeDirectory: fixture.home,
      commands: new FakeCommands(fixture.repository, {
        "git --version": { exitCode: 1, stdout: "" },
      }),
      loadConfiguration: () => fixture.config,
      validateConfiguration: async () => undefined,
    });
    const missingGlab = await inspectDoctorReadiness({
      cwd: fixture.repository,
      environment: fixture.environment,
      homeDirectory: fixture.home,
      commands: new FakeCommands(fixture.repository, {
        "glab --version": { exitCode: 1, stdout: "" },
      }),
      loadConfiguration: () => fixture.config,
      validateConfiguration: async () => undefined,
    });
    expect(missingGit.diagnostics).toContainEqual(
      expect.objectContaining({ code: "runtime-git-missing" }),
    );
    expect(missingGlab.useReadiness["draft-mr"].diagnostics).toContainEqual(
      expect.objectContaining({ code: "runtime-glab-missing" }),
    );
    expect(missingGlab.status).toBe("ready");
  });

  it("closes runtime inspection failures without retaining provider output", async () => {
    const fixture = await readyFixture();
    const canary = `nvapi-${"R".repeat(32)}`;
    const result = await inspectDoctorReadiness({
      cwd: fixture.repository,
      environment: fixture.environment,
      homeDirectory: fixture.home,
      commands: new FakeCommands(fixture.repository),
      loadConfiguration: () => fixture.config,
      validateConfiguration: async () => {
        throw new Error(`provider failed: ${canary}`);
      },
    });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "provider-runtime-unavailable" }),
    );
    expect(formatDoctorReadiness(result)).not.toContain(canary);
  });

  it("distinguishes unborn, missing, inaccessible, and invalid HEAD revisions", async () => {
    const fixture = await readyFixture();
    const base = {
      cwd: fixture.repository,
      environment: fixture.environment,
      homeDirectory: fixture.home,
      loadConfiguration: () => fixture.config,
      validateConfiguration: async () => undefined,
    };
    const [unborn, missing, inaccessible, invalid] = await Promise.all([
      inspectDoctorReadiness({
        ...base,
        commands: new FakeCommands(fixture.repository, {
          "git rev-parse --verify HEAD^{commit}": { exitCode: 1, stdout: "" },
          "git rev-parse --verify HEAD": { exitCode: 1, stdout: "" },
        }),
      }),
      inspectDoctorReadiness({
        ...base,
        commands: new FakeCommands(fixture.repository, {
          "git symbolic-ref --quiet --short HEAD": { exitCode: 1, stdout: "" },
          "git rev-parse --verify HEAD^{commit}": { exitCode: 1, stdout: "" },
          "git rev-parse --verify HEAD": { exitCode: 1, stdout: "" },
        }),
      }),
      inspectDoctorReadiness({
        ...base,
        commands: new FakeCommands(fixture.repository, {
          "git rev-parse --verify HEAD^{commit}": { exitCode: 1, stdout: "" },
          "git rev-parse --verify HEAD": {
            exitCode: 0,
            stdout: `${"b".repeat(40)}\n`,
          },
        }),
      }),
      inspectDoctorReadiness({
        ...base,
        commands: new FakeCommands(fixture.repository, {
          "git rev-parse --verify HEAD^{commit}": {
            exitCode: 0,
            stdout: "not-a-revision\n",
          },
        }),
      }),
    ]);
    expect(unborn.diagnostics).toContainEqual(
      expect.objectContaining({ code: "repository-revision-unborn" }),
    );
    expect(missing.diagnostics).toContainEqual(
      expect.objectContaining({ code: "repository-revision-missing" }),
    );
    expect(inaccessible.diagnostics).toContainEqual(
      expect.objectContaining({ code: "repository-revision-inaccessible" }),
    );
    expect(invalid.diagnostics).toContainEqual(
      expect.objectContaining({ code: "repository-revision-invalid" }),
    );
    expect(
      [unborn, missing, inaccessible, invalid].map((result) => result.repositoryRevision),
    ).toEqual([null, null, null, null]);
  });

  it("requires effective write and search access for every private root", async () => {
    const fixture = await readyFixture();
    const runs = fixture.privateRoots.runs;
    await chmod(runs, 0o500);
    const nonWritable = await inspectDoctorReadiness({
      cwd: fixture.repository,
      use: "draft-mr",
      environment: fixture.environment,
      homeDirectory: fixture.home,
      commands: new FakeCommands(fixture.repository),
      loadConfiguration: () => fixture.config,
      validateConfiguration: async () => undefined,
    });
    await chmod(runs, 0o700);
    const aclDenied = await inspectDoctorReadiness({
      cwd: fixture.repository,
      use: "draft-mr",
      environment: fixture.environment,
      homeDirectory: fixture.home,
      commands: new FakeCommands(fixture.repository),
      loadConfiguration: () => fixture.config,
      validateConfiguration: async () => undefined,
      checkPrivateAccess: async (path) => {
        if (path === fixture.privateRoots.receipts) {
          throw Object.assign(new Error("ACL denied"), { code: "EACCES" });
        }
      },
    });
    expect(nonWritable.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "private-state-unsafe",
        nextCommand: digestBoundInitNextAction(),
      }),
    );
    expect(aclDenied.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "private-state-unsafe",
        nextCommand: digestBoundInitNextAction(),
      }),
    );
    expect(formatDoctorReadiness(nonWritable)).toContain(
      `Next action: ${digestBoundInitNextAction()}`,
    );
  });

  it("points missing private state at the prompt-free preview-then-digest apply sequence", async () => {
    const fixture = await readyFixture();
    await rm(fixture.privateRoots.runs, { recursive: true, force: true });
    const result = await inspectDoctorReadiness({
      cwd: fixture.repository,
      use: "draft-mr",
      environment: fixture.environment,
      homeDirectory: fixture.home,
      commands: new FakeCommands(fixture.repository),
      loadConfiguration: () => fixture.config,
      validateConfiguration: async () => undefined,
    });
    const missing = result.diagnostics.find((item) => item.code === "private-state-missing");
    expect(missing?.nextCommand).toBe(digestBoundInitNextAction());
    expect(result.checks).toContainEqual({ area: "private-state", status: "blocked" });
    expect(formatDoctorReadiness(result)).toContain(`Next action: ${digestBoundInitNextAction()}`);
  });

  it("withholds draft-MR readiness when local GitLab credentials are unverified", async () => {
    const fixture = await readyFixture();
    const result = await inspectDoctorReadiness({
      cwd: fixture.repository,
      use: "draft-mr",
      environment: fixture.environment,
      homeDirectory: fixture.home,
      commands: new FakeCommands(
        fixture.repository,
        {},
        {
          "glab config get token --host gitlab.example.test": "unverified",
        },
      ),
      loadConfiguration: () => fixture.config,
      validateConfiguration: async () => undefined,
    });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "gitlab-login-unverified" }),
    );
    expect(result.autoModesReady).toEqual(["dry-run", "patch-only"]);
  });

  it("reports project-config-untracked when .docsfab.json exists but is not in HEAD", async () => {
    const fixture = await readyFixture();
    const result = await inspectDoctorReadiness({
      cwd: fixture.repository,
      use: "draft-mr",
      environment: fixture.environment,
      homeDirectory: fixture.home,
      commands: new FakeCommands(fixture.repository, {
        "git ls-tree --name-only HEAD -- .docsfab.json": {
          exitCode: 0,
          stdout: "",
        },
        "git status --porcelain=v1 --untracked-files=all": {
          exitCode: 0,
          stdout: "?? .docsfab.json\n",
        },
      }),
      loadConfiguration: () => fixture.config,
      validateConfiguration: async () => undefined,
    });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "project-config-untracked" }),
    );
    expect(result.diagnostics.map((item) => item.code)).not.toContain("repository-source-dirty");
    expect(result.checks).toContainEqual({
      area: "configuration",
      status: "blocked",
    });
    expect(formatDoctorReadiness(result)).toContain("Code: project-config-untracked");
  });

  it("does not report project-config-untracked when .docsfab.json is tracked and the tree is clean", async () => {
    const fixture = await readyFixture();
    const result = await inspectDoctorReadiness({
      cwd: fixture.repository,
      environment: fixture.environment,
      homeDirectory: fixture.home,
      commands: new FakeCommands(fixture.repository),
      loadConfiguration: () => fixture.config,
      validateConfiguration: async () => undefined,
    });
    expect(result.diagnostics.map((item) => item.code)).not.toContain("project-config-untracked");
    expect(result.diagnostics.map((item) => item.code)).not.toContain("repository-source-dirty");
    expect(result.projectConfiguration).toMatchObject({
      authority: "tracked",
      checkout: "clean",
      effectiveRoots: ["docs/", "fern/"],
    });
    expect(result.status).toBe("ready");
  });

  it("reports repository-source-dirty when a non-config file is dirty and config is tracked", async () => {
    const fixture = await readyFixture();
    const result = await inspectDoctorReadiness({
      cwd: fixture.repository,
      use: "draft-mr",
      environment: fixture.environment,
      homeDirectory: fixture.home,
      commands: new FakeCommands(fixture.repository, {
        "git status --porcelain=v1 --untracked-files=all": {
          exitCode: 0,
          stdout: " M README.md\n",
        },
      }),
      loadConfiguration: () => fixture.config,
      validateConfiguration: async () => undefined,
    });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "repository-source-dirty" }),
    );
    expect(result.diagnostics.map((item) => item.code)).not.toContain("project-config-untracked");
    expect(result.checks).toContainEqual({
      area: "repository",
      status: "blocked",
    });
    expect(formatDoctorReadiness(result)).not.toContain("README.md");
  });

  it("reports project-config-untracked when .docsfab.json is present but ignored", async () => {
    const fixture = await readyFixture();
    const result = await inspectDoctorReadiness({
      cwd: fixture.repository,
      use: "draft-mr",
      environment: fixture.environment,
      homeDirectory: fixture.home,
      commands: new FakeCommands(fixture.repository, {
        "git ls-tree --name-only HEAD -- .docsfab.json": {
          exitCode: 0,
          stdout: "",
        },
        "git status --porcelain=v1 --untracked-files=all": {
          exitCode: 0,
          stdout: "",
        },
      }),
      loadConfiguration: () => fixture.config,
      validateConfiguration: async () => undefined,
    });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "project-config-untracked" }),
    );
    expect(result.diagnostics.map((item) => item.code)).not.toContain("repository-source-dirty");
  });
});

describe("doctor readiness CHECKS grid dialect alignment", () => {
  const checks: DoctorReadinessResult["checks"] = [
    { area: "installation", status: "ready" },
    { area: "configuration", status: "blocked" },
    { area: "repository", status: "ready" },
  ];

  const STREAM_FIXTURES = [
    {
      name: "tty",
      options: {
        tty: true,
        noColor: false,
        forceColor: false,
        forceColorDisabled: false,
        ci: false,
        termDumb: false,
      },
    },
    {
      name: "pipe",
      options: { tty: false, noColor: false, forceColor: false, ci: false },
    },
    {
      name: "no-color tty",
      options: { tty: true, noColor: true, forceColor: false, ci: false },
    },
    {
      name: "force-color pipe",
      options: { tty: false, noColor: false, forceColor: true, ci: false },
    },
    {
      name: "ci tty",
      options: { tty: true, noColor: false, forceColor: false, ci: true },
    },
  ] as const;

  function baseResult(): DoctorReadinessResult {
    return {
      schemaVersion: 1,
      kind: "docsfab-doctor-readiness",
      status: "blocked",
      repositoryPath: "/repository",
      liveConnectivity: {
        requested: false,
        provider: "not-requested",
        gitlab: "not-requested",
      },
      checks,
      diagnostics: [],
      validationCommand: "npm run check",
      repositoryRevision: "a".repeat(40),
      checkoutBranch: "main",
      checkoutRevision: "a".repeat(40),
      gitlabTargetBranch: null,
      gitlabTargetRevision: null,
      draftMrReadiness: unobservedDraftMrReadiness(
        "blocked",
        "project-config-missing",
        "not observed in this fixture",
      ),
      remediationArgv: ["docsfab", "init", "--repo", "/repository"],
      autoModesReady: [],
    };
  }

  it.each(STREAM_FIXTURES)(
    "renders the CHECKS section with the stamped formatCheckGrid rows ($name)",
    ({ options }) => {
      const output = formatDoctorReadiness(baseResult(), options);
      expect(output).toContain(`\n${formatSectionHeader("CHECKS", options)}\n`);
      for (const line of formatCheckGrid(checks, options)) expect(output).toContain(line);
    },
  );

  it("renders the exact non-TTY row shape: two-space indent, no icon, bare word", () => {
    const output = formatDoctorReadiness(baseResult(), STREAM_FIXTURES[1].options);
    expect(output).toContain(
      ["CHECKS", "  installation: ready", "  configuration: blocked", "  repository: ready"].join(
        "\n",
      ),
    );
  });

  it("renders the exact TTY row shape: check/cross marker, 16-color + bold status word", () => {
    const output = formatDoctorReadiness(baseResult(), STREAM_FIXTURES[0].options);
    expect(output).toContain(
      [
        formatSectionHeader("CHECKS", STREAM_FIXTURES[0].options),
        "  \u2713 installation: \u001b[1m\u001b[32mready\u001b[0m",
        "  \u2717 configuration: \u001b[1m\u001b[33mblocked\u001b[0m",
        "  \u2713 repository: \u001b[1m\u001b[32mready\u001b[0m",
      ].join("\n"),
    );
  });
});

function digestBoundInitNextAction(): string {
  const next = remediationText("init");
  expect(next).toContain("docsfab init --non-interactive");
  expect(next).toContain("--approve-plan-sha256 <digest>");
  expect(next).not.toBe("docsfab init");
  expect(next).not.toMatch(/docsfab init --apply(?:\s|$)/u);
  expect(initHelp()).toContain("--non-interactive --apply");
  expect(initHelp()).toContain("--approve-plan-sha256 <digest>");
  expect(usage()).toContain("--approve-plan-sha256 <digest>");
  return next;
}

async function readyFixture(): Promise<{
  root: string;
  repository: string;
  home: string;
  environment: NodeJS.ProcessEnv;
  config: DocsFabConfig;
  privateRoots: ReturnType<typeof resolveDocsFabPrivateRoots>;
}> {
  const root = await roots.create("docsfab-doctor-readiness-", { realpath: true });
  const repositoryPath = resolve(root, "repository");
  const home = resolve(root, "home");
  const state = resolve(root, "state");
  await Promise.all([mkdir(repositoryPath), mkdir(home), mkdir(state)]);
  const repository = await realpath(repositoryPath);
  await writeFile(
    resolve(repository, ".docsfab.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      gitlab: { remote: "origin", defaultBranch: "main" },
      provider: { configuration: "host" },
      storage: { scope: "user-private" },
    })}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    resolve(repository, "package.json"),
    JSON.stringify({
      scripts: { check: "node validate.js" },
    }),
  );
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "user.name=Doctor Test",
        "-c",
        "user.email=doctor@example.test",
        ...args,
      ],
      { cwd: repository, stdio: "pipe" },
    );
  git("init", "-q", "-b", "main");
  git("add", "--", ".docsfab.json", "package.json");
  git("commit", "-qm", "fixture");
  const environment = { XDG_STATE_HOME: state };
  const privateRoots = resolveDocsFabPrivateRoots(repository, environment, home);
  await Promise.all(
    Object.values(privateRoots).map(async (path) => {
      await mkdir(path, { recursive: true, mode: 0o700 });
      await chmod(path, 0o700);
    }),
  );
  return {
    root,
    repository,
    home,
    environment,
    config: {
      projectRoot: repository,
      skillCrateDirectory: resolve(process.cwd(), "skill-crate"),
      qualityDirectory: resolve(process.cwd(), "quality"),
      qualityPackDirectory: resolve(process.cwd(), "quality-pack"),
      stateDirectory: privateRoots.runs,
      retryPolicy: {
        maxRetries: 0,
        baseDelayMs: 1_000,
        maxDelayMs: 2_000,
        retryableCategories: ["timeout"],
      },
      model: validModelConfig,
    },
    privateRoots,
  };
}
