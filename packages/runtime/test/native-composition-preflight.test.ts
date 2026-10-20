// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CLAUDE_PREFLIGHT_REPORTED_VERSION,
  CODEX_PREFLIGHT_REPORTED_VERSION,
  NATIVE_PREFLIGHT_INPUT_KIND,
  NativePreflightContractError,
  NativePreflightHostError,
  createClaudeNativePreflightAdapter,
  createCodexNativePreflightAdapter,
  createLocalNativePreflightHost,
  parseNativePreflightObservationV1,
  resolveLocalNativeExecutable,
  type NativeExecutableObservation,
  type NativeHarnessId,
  type NativePreflightHost,
  type NativePreflightInputV1,
  type NativePreflightProcessObservation,
  type NativePreflightProcessRequest,
} from "../src/native-compositions/index.js";
import { CODEX_CATALOG_ARGUMENTS } from "../src/native-compositions/contracts.js";
import { validateLocalRequest } from "../src/native-compositions/local-host.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const PRIVATE_EMAIL = "writer@example.test";
const PRIVATE_ORG_ID = "ae6cdefa-a29d-44f9-af49-72d85aede8c8";
const PRIVATE_ORG_NAME = "Example Enterprise";

function input(harnessId: NativeHarnessId): NativePreflightInputV1 {
  const codex = harnessId === "codex";
  return {
    schemaVersion: 1,
    kind: NATIVE_PREFLIGHT_INPUT_KIND,
    harnessId,
    routeId: codex ? "codex-chatgpt-managed" : "claude-ai-managed",
    executionClass: "preflight-only",
    requestedModel: codex ? "gpt-5.6-sol" : "claude-opus-4-7-20260801",
    executablePath: codex ? "/opt/docsfab/bin/codex" : "/opt/docsfab/bin/claude",
    expectedExecutable: {
      basename: codex ? "codex" : "claude",
      sha256: SHA_A,
      identitySha256: SHA_B,
      reportedVersion: codex ? CODEX_PREFLIGHT_REPORTED_VERSION : CLAUDE_PREFLIGHT_REPORTED_VERSION,
    },
    environment: {
      HOME: "/Users/tester",
      LANG: "C.UTF-8",
      TMPDIR: "/private/tmp/docsfab-native-preflight",
    },
  };
}

function executable(harnessId: NativeHarnessId): NativeExecutableObservation {
  return {
    canonicalPath: harnessId === "codex" ? "/opt/docsfab/bin/codex" : "/opt/docsfab/bin/claude",
    basename: harnessId === "codex" ? "codex" : "claude",
    sha256: SHA_A,
    identitySha256: SHA_B,
    trusted: true,
  };
}

function processObservation(
  stdout: string,
  overrides: Partial<NativePreflightProcessObservation> = {},
): NativePreflightProcessObservation {
  const output = overrides.stdout ?? Buffer.from(stdout, "utf8");
  const error = overrides.stderr ?? Buffer.alloc(0);
  return {
    status: "settled",
    exitCode: 0,
    signal: null,
    durationMs: 8,
    stdout: output,
    stderr: error,
    stdoutBytes: output.byteLength,
    stderrBytes: error.byteLength,
    stdoutOverflow: false,
    stderrOverflow: false,
    ...overrides,
  };
}

function codexOutput(request: NativePreflightProcessRequest): NativePreflightProcessObservation {
  if (request.operation === "version") {
    return processObservation(`${CODEX_PREFLIGHT_REPORTED_VERSION}\n`);
  }
  if (request.operation === "authentication") {
    return processObservation("", { stderr: Buffer.from("Logged in using ChatGPT\n", "utf8") });
  }
  return processObservation(
    JSON.stringify({
      models: [
        { slug: "gpt-5.6-luna", display_name: "GPT-5.6 Luna" },
        { slug: "gpt-5.6-sol", display_name: "GPT-5.6 Sol" },
      ],
    }),
  );
}

function claudeAuthOutput(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    loggedIn: true,
    authMethod: "claude.ai",
    apiProvider: "firstParty",
    email: PRIVATE_EMAIL,
    orgId: PRIVATE_ORG_ID,
    orgName: PRIVATE_ORG_NAME,
    subscriptionType: "enterprise",
    ...overrides,
  });
}

function claudeOutput(request: NativePreflightProcessRequest): NativePreflightProcessObservation {
  return request.operation === "version"
    ? processObservation(`${CLAUDE_PREFLIGHT_REPORTED_VERSION}\n`)
    : processObservation(claudeAuthOutput());
}

function host(
  harnessId: NativeHarnessId,
  output: (request: NativePreflightProcessRequest) => NativePreflightProcessObservation,
): NativePreflightHost & {
  inspectExecutable: ReturnType<typeof vi.fn>;
  runProcess: ReturnType<typeof vi.fn>;
} {
  return {
    inspectExecutable: vi.fn(async () => executable(harnessId)),
    // Every fake request passes the real local host's pre-spawn admission
    // first, so a command the real host would refuse cannot pass here.
    runProcess: vi.fn(async (request: NativePreflightProcessRequest) => {
      validateLocalRequest(request);
      return output(request);
    }),
  };
}

describe("native composition preflight adapters", () => {
  it("projects a Codex ChatGPT preflight without making model egress representable", async () => {
    const fakeHost = host("codex", codexOutput);
    const adapter = createCodexNativePreflightAdapter(fakeHost);
    const result = await adapter.preflight(input("codex"));

    expect(result.terminalCode).toBe("preflight-ready");
    expect(result.capabilities).toEqual({
      modelEgress: "unavailable",
      workflowExecution: "unavailable",
    });
    expect(result.observedModel).toBeNull();
    expect(result.authentication).toMatchObject({
      status: "ready",
      mechanism: "chatgpt",
      providerClass: "openai-first-party",
      subscriptionClass: "not-observed",
    });
    expect(result.catalog).toMatchObject({
      source: "codex-bundled",
      availability: "available",
    });
    expect(adapter).not.toHaveProperty("run");
    expect(adapter).not.toHaveProperty("execute");

    expect(fakeHost.runProcess.mock.calls.map(([request]) => request.arguments)).toEqual([
      ["--version"],
      ["login", "status"],
      ["debug", "models", "--bundled"],
    ]);
    for (const [request] of fakeHost.runProcess.mock.calls) {
      expect(request.executablePath).toBe("/opt/docsfab/bin/codex");
      expect(request.environment).toEqual(input("codex").environment);
      expect(request).not.toHaveProperty("stdin");
      expect(request).not.toHaveProperty("prompt");
      expect(request).not.toHaveProperty("requestedModel");
      expect(request).not.toHaveProperty("workingDirectory");
    }
    expect(parseNativePreflightObservationV1(result)).toEqual(result);
  });

  it("projects only non-PII Claude enterprise authentication evidence", async () => {
    const fakeHost = host("claude-code", claudeOutput);
    const adapter = createClaudeNativePreflightAdapter(fakeHost);
    const result = await adapter.preflight(input("claude-code"));
    const serialized = JSON.stringify(result);

    expect(result.terminalCode).toBe("preflight-ready");
    expect(result.authentication).toMatchObject({
      status: "ready",
      mechanism: "claude.ai",
      providerClass: "anthropic-first-party",
      subscriptionClass: "enterprise",
    });
    expect(result.catalog).toEqual({
      source: "not-observed",
      availability: "not-observed",
      projectionSha256: null,
    });
    expect(serialized).not.toContain(PRIVATE_EMAIL);
    expect(serialized).not.toContain(PRIVATE_ORG_ID);
    expect(serialized).not.toContain(PRIVATE_ORG_NAME);
    expect(fakeHost.runProcess.mock.calls.map(([request]) => request.arguments)).toEqual([
      ["--version"],
      ["auth", "status", "--json"],
    ]);
    expect(adapter).not.toHaveProperty("run");
  });

  it("admits the canonical claude.exe target used by the packaged Claude launcher", async () => {
    const fakeHost = host("claude-code", claudeOutput);
    fakeHost.inspectExecutable.mockResolvedValue({
      ...executable("claude-code"),
      canonicalPath: "/opt/docsfab/bin/claude.exe",
      basename: "claude.exe",
    });
    const candidate = {
      ...input("claude-code"),
      executablePath: "/opt/docsfab/bin/claude.exe",
      expectedExecutable: {
        ...input("claude-code").expectedExecutable,
        basename: "claude.exe" as const,
      },
    };

    const result = await createClaudeNativePreflightAdapter(fakeHost).preflight(candidate);

    expect(result.terminalCode).toBe("preflight-ready");
    expect(result.executable.basename).toBe("claude.exe");
    expect(
      fakeHost.runProcess.mock.calls.every(([request]) =>
        request.executablePath.endsWith("claude.exe"),
      ),
    ).toBe(true);
  });

  it.each([
    ["inference hub", "INFERENCE_HUB_METADATA_API_KEY", `nvapi-${"x".repeat(40)}`],
    ["OpenAI API", "OPENAI_API_KEY", `sk-${"x".repeat(40)}`],
    ["Anthropic API", "ANTHROPIC_API_KEY", `sk-ant-${"x".repeat(40)}`],
  ] as const)(
    "rejects an unrelated %s credential before any host call",
    async (_label, key, value) => {
      const fakeHost = host("codex", codexOutput);
      const adapter = createCodexNativePreflightAdapter(fakeHost);
      const candidate = {
        ...input("codex"),
        environment: { ...input("codex").environment, [key]: value },
      };

      let thrown: unknown;
      try {
        await adapter.preflight(candidate);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(NativePreflightContractError);
      expect(String(thrown)).not.toContain(value);
      expect(fakeHost.inspectExecutable).not.toHaveBeenCalled();
      expect(fakeHost.runProcess).not.toHaveBeenCalled();
    },
  );

  it("rejects unknown environment authority and non-canonical executable paths", async () => {
    const fakeHost = host("claude-code", claudeOutput);
    const adapter = createClaudeNativePreflightAdapter(fakeHost);

    await expect(
      adapter.preflight({
        ...input("claude-code"),
        environment: { ...input("claude-code").environment, PATH: "/usr/bin" },
      }),
    ).rejects.toMatchObject({ code: "environment-policy" });
    await expect(
      adapter.preflight({ ...input("claude-code"), executablePath: "./claude" }),
    ).rejects.toMatchObject({ code: "executable-policy" });
    expect(fakeHost.inspectExecutable).not.toHaveBeenCalled();
    expect(fakeHost.runProcess).not.toHaveBeenCalled();
  });

  it("fails when the exact executable changes after the fixed preflight sequence", async () => {
    const fakeHost = host("codex", codexOutput);
    fakeHost.inspectExecutable
      .mockResolvedValueOnce(executable("codex"))
      .mockResolvedValueOnce({ ...executable("codex"), identitySha256: SHA_C });
    const result = await createCodexNativePreflightAdapter(fakeHost).preflight(input("codex"));

    expect(result.terminalCode).toBe("executable-drift");
    expect(result.reasonCodes).toEqual(["executable-drift"]);
    expect(result.observedModel).toBeNull();
  });

  it("requires the adapter-pinned version before interpreting auth output", async () => {
    const fakeHost = host("codex", (request) =>
      request.operation === "version"
        ? processObservation("codex-cli 0.148.0\n")
        : codexOutput(request),
    );
    const result = await createCodexNativePreflightAdapter(fakeHost).preflight(input("codex"));

    expect(result.terminalCode).toBe("executable-drift");
    expect(fakeHost.runProcess).toHaveBeenCalledTimes(1);
    expect(result.executable.reportedVersion).toBe("not-attested");
  });

  it("rejects Codex auth mismatch and unavailable bundled models without fallback", async () => {
    const authHost = host("codex", (request) =>
      request.operation === "authentication"
        ? processObservation("", {
            stderr: Buffer.from("Logged in using an API key\n", "utf8"),
          })
        : codexOutput(request),
    );
    const authResult = await createCodexNativePreflightAdapter(authHost).preflight(input("codex"));
    expect(authResult.terminalCode).toBe("authentication-mismatch");
    expect(authHost.runProcess).toHaveBeenCalledTimes(2);

    const catalogHost = host("codex", (request) =>
      request.operation === "catalog"
        ? processObservation(JSON.stringify({ models: [{ slug: "gpt-5.6-luna" }] }))
        : codexOutput(request),
    );
    const catalogResult = await createCodexNativePreflightAdapter(catalogHost).preflight(
      input("codex"),
    );
    expect(catalogResult.terminalCode).toBe("model-unavailable");
    expect(catalogResult.catalog.availability).toBe("unavailable");
    expect(catalogHost.runProcess).toHaveBeenCalledTimes(3);
  });

  it("rejects Claude auth routes other than first-party enterprise", async () => {
    const fakeHost = host("claude-code", (request) =>
      request.operation === "authentication"
        ? processObservation(claudeAuthOutput({ apiProvider: "bedrock" }))
        : claudeOutput(request),
    );
    const result = await createClaudeNativePreflightAdapter(fakeHost).preflight(
      input("claude-code"),
    );

    expect(result.terminalCode).toBe("authentication-mismatch");
    expect(result.authentication.status).toBe("unavailable");
    expect(JSON.stringify(result)).not.toContain(PRIVATE_EMAIL);
  });

  it("maps credential-bearing process output to one content-free code", async () => {
    const synthetic = `glpat-${"z".repeat(24)}`;
    const fakeHost = host("claude-code", (request) =>
      request.operation === "version"
        ? processObservation(CLAUDE_PREFLIGHT_REPORTED_VERSION, {
            stderr: Buffer.from(synthetic, "utf8"),
          })
        : claudeOutput(request),
    );
    const result = await createClaudeNativePreflightAdapter(fakeHost).preflight(
      input("claude-code"),
    );

    expect(result.terminalCode).toBe("credential-boundary");
    expect(JSON.stringify(result)).not.toContain(synthetic);
    expect(fakeHost.runProcess).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["timeout", { status: "timeout", exitCode: null }],
    ["output-limit", { stdoutOverflow: true }],
    ["process-failed", { exitCode: 7 }],
    ["malformed-output", { stdoutBytes: 999 }],
  ] as const)("fails closed for a %s process observation", async (code, overrides) => {
    const fakeHost = host("codex", (request) =>
      request.operation === "version"
        ? processObservation(CODEX_PREFLIGHT_REPORTED_VERSION, overrides)
        : codexOutput(request),
    );
    const result = await createCodexNativePreflightAdapter(fakeHost).preflight(input("codex"));

    expect(result.terminalCode).toBe(code);
    expect(fakeHost.runProcess).toHaveBeenCalledTimes(1);
  });

  it("normalizes an inspector exception without retaining its content", async () => {
    const synthetic = `glpat-${"q".repeat(24)}`;
    const fakeHost = host("claude-code", claudeOutput);
    fakeHost.inspectExecutable.mockRejectedValue(new Error(synthetic));

    let thrown: unknown;
    try {
      await createClaudeNativePreflightAdapter(fakeHost).preflight(input("claude-code"));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(NativePreflightHostError);
    expect(thrown).toMatchObject({ code: "host-operation-failed" });
    expect(String(thrown)).not.toContain(synthetic);
    expect(fakeHost.runProcess).not.toHaveBeenCalled();
  });

  it("rejects forged observation fields even when the remaining digest is valid-looking", async () => {
    const result = await createCodexNativePreflightAdapter(host("codex", codexOutput)).preflight(
      input("codex"),
    );
    const forged = { ...result, rawAuthStatus: "forbidden" };

    expect(() => parseNativePreflightObservationV1(forged)).toThrow("invalid-shape");
  });

  it("provides a no-shell local host that admits only the fixed preflight argv", async () => {
    const localHost = createLocalNativePreflightHost();
    const executablePath = await realpath(process.execPath);
    const executableObservation = await localHost.inspectExecutable(executablePath);

    expect(executableObservation.canonicalPath).toBe(executablePath);
    expect(executableObservation.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(executableObservation.identitySha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(executableObservation.trusted).toBe(true);

    const version = await localHost.runProcess({
      operation: "version",
      executablePath,
      arguments: ["--version"],
      environment: { HOME: "/private/tmp", LANG: "C" },
      timeoutMs: 5_000,
      maxStdoutBytes: 4_096,
      maxStderrBytes: 4_096,
    });
    expect(version.status).toBe("settled");
    expect(version.exitCode).toBe(0);
    expect(version.stdout.toString("utf8")).toMatch(/^v\d+/u);

    await expect(
      localHost.runProcess({
        operation: "version",
        executablePath,
        arguments: ["-e", "process.stdout.write('not allowed')"],
        environment: { HOME: "/private/tmp", LANG: "C" },
        timeoutMs: 5_000,
        maxStdoutBytes: 4_096,
        maxStderrBytes: 4_096,
      }),
    ).rejects.toMatchObject({ code: "host-operation-failed" });
  });

  it.each([
    {
      name: "nativePreflight.catalogModelCount",
      refusal: "native-preflight-catalog-model-count-bound",
      models: Array.from({ length: 257 }, (_, index) => ({ slug: `model-${index}` })),
      observed: 257,
      value: 256,
    },
    {
      name: "nativePreflight.catalogSlugCharacters",
      refusal: "native-preflight-catalog-slug-characters-bound",
      models: [{ slug: `g${"x".repeat(128)}` }, { slug: "gpt-5.6-sol" }],
      observed: 129,
      value: 128,
    },
  ])(
    "stops a catalog that exceeds $name with a named evidence-limit, not malformed-output",
    async (limitCase) => {
      const fakeHost = host("codex", (request) =>
        request.operation === "catalog"
          ? processObservation(JSON.stringify({ models: limitCase.models }))
          : codexOutput(request),
      );
      const result = await createCodexNativePreflightAdapter(fakeHost).preflight(input("codex"));

      expect(result.terminalCode).toBe("evidence-limit");
      const catalogProcess = result.processes.find((process) => process.operation === "catalog");
      expect(catalogProcess?.limitNotices).toEqual([
        expect.objectContaining({
          name: limitCase.name,
          refusal: limitCase.refusal,
          observed: limitCase.observed,
          value: limitCase.value,
          source: "native-preflight:catalog",
        }),
      ]);
      expect(result.catalog.availability).toBe("not-observed");
      expect(parseNativePreflightObservationV1(result)).toEqual(result);
    },
  );

  it("admits exactly the pinned Codex catalog argv before spawning, bundled and account", () => {
    // #1512: the 0.155.1 pin reads the account catalog. The real host refused
    // `debug models` before spawning (live host-operation-failed at 3621528f),
    // because only the bundled argv was admitted. The adapter and the host now
    // share CODEX_CATALOG_ARGUMENTS.
    const request = (
      executablePath: string,
      argumentsValue: readonly string[],
    ): NativePreflightProcessRequest => ({
      operation: "catalog",
      executablePath,
      arguments: argumentsValue,
      environment: { HOME: "/private/tmp", LANG: "C" },
      timeoutMs: 5_000,
      maxStdoutBytes: 2_097_152,
      maxStderrBytes: 16_384,
    });
    expect(CODEX_CATALOG_ARGUMENTS).toEqual({
      "codex-bundled": ["debug", "models", "--bundled"],
      "codex-account": ["debug", "models"],
    });
    for (const argumentsValue of Object.values(CODEX_CATALOG_ARGUMENTS)) {
      expect(() => validateLocalRequest(request("/opt/bin/codex", argumentsValue))).not.toThrow();
    }
    for (const argumentsValue of [
      ["debug", "models", "--json"],
      ["debug", "models", "--bundled", "--account"],
      ["debug"],
      ["models"],
    ]) {
      expect(() => validateLocalRequest(request("/opt/bin/codex", argumentsValue))).toThrow(
        expect.objectContaining({ code: "host-operation-failed" }),
      );
    }
    // Only a Codex executable may run a catalog command.
    expect(() =>
      validateLocalRequest(request("/opt/bin/claude", CODEX_CATALOG_ARGUMENTS["codex-account"]!)),
    ).toThrow(expect.objectContaining({ code: "host-operation-failed" }));
  });

  it("resolves a launcher symlink to one canonical .exe target before inspection", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-native-launcher-"));
    try {
      const target = join(root, "claude.exe");
      const launcher = join(root, "claude");
      await writeFile(target, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      await symlink(target, launcher);
      const canonicalTarget = await realpath(target);

      const resolved = await resolveLocalNativeExecutable("claude-code", launcher);
      const observation = await createLocalNativePreflightHost().inspectExecutable(resolved);

      expect(resolved).toBe(canonicalTarget);
      expect(observation).toMatchObject({
        canonicalPath: canonicalTarget,
        basename: "claude.exe",
        trusted: true,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
