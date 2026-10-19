// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { formatLimitRefusal, limit, limitDefinition, resolveLimits } from "../src/config/limits.js";
import {
  CODEX_PREFLIGHT_REPORTED_VERSION,
  NATIVE_PREFLIGHT_INPUT_KIND,
  NATIVE_PREFLIGHT_LIMITS,
  createCodexNativePreflightAdapter,
  parseNativePreflightObservationV1,
  type NativeExecutableObservation,
  type NativePreflightHost,
  type NativePreflightInputV1,
  type NativePreflightProcessObservation,
  type NativePreflightProcessRequest,
} from "../src/native-compositions/index.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const RECORDED_DURATION = limit("nativePreflight.recordedDurationMs");
const RECORDED_STDOUT = limit("nativePreflight.recordedStdoutBytes");
const RECORDED_STDERR = limit("nativePreflight.recordedStderrBytes");
const VERSION_STDOUT = limit("nativePreflight.versionStdoutBytes");
const STDERR = limit("nativePreflight.maxStderrBytes");

function input(): NativePreflightInputV1 {
  return {
    schemaVersion: 1,
    kind: NATIVE_PREFLIGHT_INPUT_KIND,
    harnessId: "codex",
    routeId: "codex-chatgpt-managed",
    executionClass: "preflight-only",
    requestedModel: "gpt-5.6-sol",
    executablePath: "/opt/docsfab/bin/codex",
    expectedExecutable: {
      basename: "codex",
      sha256: SHA_A,
      identitySha256: SHA_B,
      reportedVersion: CODEX_PREFLIGHT_REPORTED_VERSION,
    },
    environment: {
      HOME: "/Users/tester",
      LANG: "C.UTF-8",
      TMPDIR: "/private/tmp/docsfab-native-preflight",
    },
  };
}

function executable(): NativeExecutableObservation {
  return {
    canonicalPath: "/opt/docsfab/bin/codex",
    basename: "codex",
    sha256: SHA_A,
    identitySha256: SHA_B,
    trusted: true,
  };
}

function processObservation(
  stdout: string | Buffer,
  overrides: Partial<NativePreflightProcessObservation> = {},
): NativePreflightProcessObservation {
  const output =
    overrides.stdout ?? (Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout, "utf8"));
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

function versionBytes(size: number): Buffer {
  return Buffer.alloc(size, 0x61);
}

function host(
  output: (request: NativePreflightProcessRequest) => NativePreflightProcessObservation,
): NativePreflightHost & { runProcess: ReturnType<typeof vi.fn> } {
  return {
    inspectExecutable: vi.fn(async () => executable()),
    runProcess: vi.fn(async (request: NativePreflightProcessRequest) => output(request)),
  };
}

function versionThenRest(
  version: NativePreflightProcessObservation,
): (request: NativePreflightProcessRequest) => NativePreflightProcessObservation {
  return (request) => {
    if (request.operation === "version") return version;
    if (request.operation === "authentication") {
      return processObservation("", { stderr: Buffer.from("Logged in using ChatGPT\n", "utf8") });
    }
    return processObservation(
      JSON.stringify({
        models: [{ slug: "gpt-5.6-luna" }, { slug: "gpt-5.6-sol" }],
      }),
    );
  };
}

describe("native preflight adapter evidence limits", () => {
  it("records duration at the catalog bound without rewriting it", async () => {
    const fakeHost = host(
      versionThenRest(
        processObservation(`${CODEX_PREFLIGHT_REPORTED_VERSION}\n`, {
          durationMs: RECORDED_DURATION.value,
        }),
      ),
    );
    const result = await createCodexNativePreflightAdapter(fakeHost).preflight(input());

    expect(result.terminalCode).toBe("preflight-ready");
    expect(result.processes[0]?.durationMs).toBe(RECORDED_DURATION.value);
    expect(result.processes[0]?.limitNotices).toEqual([]);
    expect(parseNativePreflightObservationV1(result)).toEqual(result);
  });

  it("keeps measured duration at the catalog bound plus one and names the source", async () => {
    const observed = RECORDED_DURATION.value + 1;
    const fakeHost = host(
      versionThenRest(
        processObservation(`${CODEX_PREFLIGHT_REPORTED_VERSION}\n`, { durationMs: observed }),
      ),
    );
    const result = await createCodexNativePreflightAdapter(fakeHost).preflight(input());

    expect(result.terminalCode).toBe("evidence-limit");
    expect(result.processes[0]?.durationMs).toBe(observed);
    expect(result.processes[0]?.limitNotices).toEqual([
      {
        name: RECORDED_DURATION.name,
        observed,
        value: RECORDED_DURATION.value,
        unit: RECORDED_DURATION.unit,
        refusal: RECORDED_DURATION.refusal,
        message: formatLimitRefusal(RECORDED_DURATION, observed),
        source: "native-preflight:version",
      },
    ]);
    expect(parseNativePreflightObservationV1(result)).toEqual(result);
  });

  it("records duration at the capture timeout plus one instead of clamping it", async () => {
    const observed = NATIVE_PREFLIGHT_LIMITS.timeoutMs + 1;
    const fakeHost = host(
      versionThenRest(
        processObservation(`${CODEX_PREFLIGHT_REPORTED_VERSION}\n`, { durationMs: observed }),
      ),
    );
    const result = await createCodexNativePreflightAdapter(fakeHost).preflight(input());

    expect(result.terminalCode).toBe("preflight-ready");
    expect(result.processes[0]?.durationMs).toBe(observed);
    expect(result.processes[0]?.limitNotices).toEqual([]);
  });

  it("records stdout at the version capture bound", async () => {
    const fakeHost = host(versionThenRest(processObservation(versionBytes(VERSION_STDOUT.value))));
    const result = await createCodexNativePreflightAdapter(fakeHost).preflight(input());

    expect(result.processes[0]?.stdoutBytes).toBe(VERSION_STDOUT.value);
    expect(result.processes[0]?.stdoutOverflow).toBe(false);
    expect(result.terminalCode).not.toBe("preflight-ready");
  });

  it("records stdout at the version capture bound plus one without Math.min", async () => {
    const observed = VERSION_STDOUT.value + 1;
    const fakeHost = host(versionThenRest(processObservation(versionBytes(observed))));
    const result = await createCodexNativePreflightAdapter(fakeHost).preflight(input());

    expect(result.terminalCode).toBe("malformed-output");
    expect(result.processes[0]?.stdoutBytes).toBe(observed);
    expect(result.processes[0]?.stdoutOverflow).toBe(false);
  });

  it("keeps overflow flags and actual captured stdout on output-limit", async () => {
    const captured = VERSION_STDOUT.value;
    const fakeHost = host(
      versionThenRest(processObservation(versionBytes(captured), { stdoutOverflow: true })),
    );
    const result = await createCodexNativePreflightAdapter(fakeHost).preflight(input());

    expect(result.terminalCode).toBe("output-limit");
    expect(result.processes[0]?.stdoutBytes).toBe(captured);
    expect(result.processes[0]?.stdoutOverflow).toBe(true);
    expect(parseNativePreflightObservationV1(result)).toEqual(result);
  });

  it("records stderr at the capture bound plus one without rewriting it", async () => {
    const observed = STDERR.value + 1;
    const fakeHost = host(
      versionThenRest(
        processObservation(`${CODEX_PREFLIGHT_REPORTED_VERSION}\n`, {
          stderr: Buffer.alloc(observed, 0x62),
        }),
      ),
    );
    const result = await createCodexNativePreflightAdapter(fakeHost).preflight(input());

    expect(result.processes[0]?.stderrBytes).toBe(observed);
    expect(result.processes[0]?.stderrOverflow).toBe(false);
    expect(result.terminalCode).toBe("malformed-output");
  });

  it("keeps measured stdout at the recording bound plus one with a sourced notice", async () => {
    const observed = RECORDED_STDOUT.value + 1;
    const fakeHost = host(versionThenRest(processObservation(versionBytes(observed))));
    const result = await createCodexNativePreflightAdapter(fakeHost).preflight(input());

    expect(result.processes[0]?.stdoutBytes).toBe(observed);
    expect(result.processes[0]?.limitNotices).toEqual([
      {
        name: RECORDED_STDOUT.name,
        observed,
        value: RECORDED_STDOUT.value,
        unit: RECORDED_STDOUT.unit,
        refusal: RECORDED_STDOUT.refusal,
        message: formatLimitRefusal(RECORDED_STDOUT, observed),
        source: "native-preflight:version",
      },
    ]);
    expect(result.terminalCode).toBe("malformed-output");
  });

  it("keeps measured stderr at the recording bound plus one with a sourced notice", async () => {
    const observed = RECORDED_STDERR.value + 1;
    const fakeHost = host(
      versionThenRest(
        processObservation(`${CODEX_PREFLIGHT_REPORTED_VERSION}\n`, {
          stderr: Buffer.alloc(observed, 0x63),
        }),
      ),
    );
    const result = await createCodexNativePreflightAdapter(fakeHost).preflight(input());

    expect(result.processes[0]?.stderrBytes).toBe(observed);
    expect(result.processes[0]?.limitNotices[0]).toMatchObject({
      name: RECORDED_STDERR.name,
      observed,
      source: "native-preflight:version",
      message: formatLimitRefusal(RECORDED_STDERR, observed),
    });
    expect(result.terminalCode).toBe("malformed-output");
  });
});

const NATIVE_PREFLIGHT_LIMIT_NAMES = [
  "nativePreflight.timeoutMs",
  "nativePreflight.versionStdoutBytes",
  "nativePreflight.authenticationStdoutBytes",
  "nativePreflight.catalogStdoutBytes",
  "nativePreflight.maxStderrBytes",
  "nativePreflight.recordedDurationMs",
  "nativePreflight.recordedStdoutBytes",
  "nativePreflight.recordedStderrBytes",
] as const;

function hostShrink(assignments: Record<string, number>) {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(assignments)) {
    const key = limitDefinition(name).override;
    if (!key) {
      throw new Error(`missing host override key for ${name}`);
    }
    environment[key] = String(value);
  }
  return { environment, hostFile: null as const };
}

describe("native preflight host override keys", () => {
  it.each(NATIVE_PREFLIGHT_LIMIT_NAMES)(
    "%s shrinks through the central parser and refuses a raise or malformed value at startup",
    (name) => {
      const definition = limitDefinition(name);
      expect(definition.override).toMatch(/^DOCSFAB_[A-Z0-9_]+$/u);
      const options = hostShrink({ [name]: definition.min });
      expect(limit(name, options)).toMatchObject({
        value: definition.min,
        source: "host",
      });
      expect(() =>
        resolveLimits({
          environment: { [definition.override!]: String(definition.max + 1) },
          hostFile: null,
        }),
      ).toThrow(
        `${definition.override} must be an integer between ${definition.min} and ${definition.max}.`,
      );
      expect(() =>
        resolveLimits({
          environment: { [definition.override!]: "not-a-number" },
          hostFile: null,
        }),
      ).toThrow(
        `${definition.override} must be an integer between ${definition.min} and ${definition.max}.`,
      );
    },
  );

  it("keeps measured duration at a host-shrunk bound plus one with a sourced notice", async () => {
    const options = hostShrink({ "nativePreflight.recordedDurationMs": 10 });
    const bound = limit("nativePreflight.recordedDurationMs", options);
    const observed = bound.value + 1;
    const fakeHost = host(
      versionThenRest(
        processObservation(`${CODEX_PREFLIGHT_REPORTED_VERSION}\n`, { durationMs: observed }),
      ),
    );
    const result = await createCodexNativePreflightAdapter(fakeHost, options).preflight(input());

    expect(bound.value).toBe(10);
    expect(result.terminalCode).toBe("evidence-limit");
    expect(result.processes[0]?.durationMs).toBe(observed);
    expect(result.processes[0]?.limitNotices).toEqual([
      {
        name: bound.name,
        observed,
        value: bound.value,
        unit: bound.unit,
        refusal: bound.refusal,
        message: formatLimitRefusal(bound, observed),
        source: "native-preflight:version",
      },
    ]);
  });

  it("records duration at a host-shrunk bound without rewriting it", async () => {
    const options = hostShrink({ "nativePreflight.recordedDurationMs": 10 });
    const bound = limit("nativePreflight.recordedDurationMs", options);
    const fakeHost = host(
      versionThenRest(
        processObservation(`${CODEX_PREFLIGHT_REPORTED_VERSION}\n`, {
          durationMs: bound.value,
        }),
      ),
    );
    const result = await createCodexNativePreflightAdapter(fakeHost, options).preflight(input());

    expect(result.terminalCode).toBe("preflight-ready");
    expect(result.processes[0]?.durationMs).toBe(bound.value);
    expect(result.processes[0]?.limitNotices).toEqual([]);
  });

  it("records stdout at a host-shrunk capture bound plus one without Math.min", async () => {
    const options = hostShrink({ "nativePreflight.versionStdoutBytes": 16 });
    const bound = limit("nativePreflight.versionStdoutBytes", options);
    const observed = bound.value + 1;
    const fakeHost = host(versionThenRest(processObservation(versionBytes(observed))));
    const result = await createCodexNativePreflightAdapter(fakeHost, options).preflight(input());

    expect(bound.value).toBe(16);
    expect(result.terminalCode).toBe("malformed-output");
    expect(result.processes[0]?.stdoutBytes).toBe(observed);
    expect(result.processes[0]?.stdoutOverflow).toBe(false);
  });
});
