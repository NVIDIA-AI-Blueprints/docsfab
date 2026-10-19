// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import type { DocsFabConfig } from "../src/config/runtime-loader.js";
import type { DoctorReadinessCommandRunner } from "../src/doctor-readiness.js";
import { readyDoctorFixture } from "./helpers/doctor-ready-fixture.js";
import { temporaryRoots } from "./helpers/temp.js";

const injected = vi.hoisted(() => ({
  options: {} as Record<string, unknown>,
  config: undefined as unknown,
  liveDiagnoseCalls: 0,
}));

vi.mock("../src/doctor-readiness.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/doctor-readiness.js")>();
  return {
    ...actual,
    // The command's own argv (cwd, live, use) wins over the fixture seams.
    inspectDoctorReadiness: (options: Record<string, unknown> = {}) =>
      actual.inspectDoctorReadiness({ ...injected.options, ...options }),
  };
});

vi.mock("../src/config/runtime-loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config/runtime-loader.js")>();
  return { ...actual, loadConfig: () => injected.config as DocsFabConfig };
});

vi.mock("../src/doctor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/doctor.js")>();
  return {
    ...actual,
    // Readiness owns the one live check; a second one would be a paid call.
    diagnose: (config: DocsFabConfig, options?: { live?: boolean }) => {
      if (options?.live) {
        injected.liveDiagnoseCalls += 1;
        throw new Error("The configuration summary must not run a second live check.");
      }
      return actual.diagnose(config, options);
    },
  };
});

import { handleDoctorCommand } from "../src/cli/commands/doctor.js";
import { formatDoctorResult, type DoctorResult } from "../src/doctor.js";
import { validModelConfig } from "./helpers.js";

const roots = temporaryRoots();

/** Pinned as literals so the operator-facing lines are checked apart from the source. */
const LIVE_LINES = {
  "not-requested": "Live inference: not requested (use --live)",
  "not-attempted": "Live inference: not attempted (offline readiness is blocked)",
  passed: "Live inference: passed (checked by --live)",
  failed: "Live inference: failed (checked by --live; see the provider diagnostic)",
} as const;

afterEach(() => {
  injected.options = {};
  injected.config = undefined;
  injected.liveDiagnoseCalls = 0;
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

async function doctor(args: string[]): Promise<{ text: string; exitCode: number }> {
  const printed: string[] = [];
  const capture = (message?: unknown) => {
    printed.push(String(message ?? ""));
  };
  vi.spyOn(console, "log").mockImplementation(capture);
  vi.spyOn(console, "error").mockImplementation(capture);
  process.exitCode = undefined;
  await handleDoctorCommand(args);
  const exitCode = Number(process.exitCode ?? 0);
  process.exitCode = undefined;
  vi.restoreAllMocks();
  return { text: printed.join("\n"), exitCode };
}

/** A ready checkout whose provider live check is the counted seam. */
async function liveFixture(checkProvider: () => Promise<unknown>) {
  const fixture = await readyDoctorFixture(roots);
  const calls = { provider: 0 };
  injected.config = fixture.config;
  injected.options = {
    ...fixture.options,
    loadConfiguration: () => fixture.config,
    validateConfiguration: async () => undefined,
    checkProviderConnectivity: async () => {
      calls.provider += 1;
      return checkProvider();
    },
  };
  return { fixture, calls };
}

describe("doctor --live reports the live check it ran in every summary", () => {
  it("reports the passed live check without a second live call", async () => {
    const { fixture, calls } = await liveFixture(async () => ({ live: { latencyMs: 7 } }));

    const human = await doctor(["--repo", fixture.repository, "--live"]);
    expect(human.exitCode).toBe(0);
    expect(human.text).toContain(
      "Live connectivity: requested=true, provider=passed, gitlab=not-attempted",
    );
    expect(human.text).toContain("Result: ready for local-review");
    expect(human.text).toContain(LIVE_LINES.passed);
    expect(human.text).not.toContain(LIVE_LINES["not-requested"]);
    expect(calls.provider).toBe(1);

    const json = await doctor(["--repo", fixture.repository, "--live", "--json"]);
    expect(JSON.parse(json.text).liveConnectivity).toEqual({
      requested: true,
      provider: "passed",
      gitlab: "not-attempted",
    });
    expect(calls.provider).toBe(2);
    expect(injected.liveDiagnoseCalls).toBe(0);
  });

  it("expands the recorded live observation in verbose mode without probing again", async () => {
    const { fixture, calls } = await liveFixture(async () => ({ live: { latencyMs: 9 } }));

    const human = await doctor(["--repo", fixture.repository, "--live", "--verbose"]);

    expect(human.exitCode).toBe(0);
    expect(human.text).toContain("Live connectivity: requested=true, provider=passed");
    expect(human.text).toContain(LIVE_LINES.passed);
    expect(calls.provider).toBe(1);
    expect(injected.liveDiagnoseCalls).toBe(0);
  });

  it("reports a failed check as failed in human and JSON output", async () => {
    const { fixture, calls } = await liveFixture(async () => {
      throw new Error("The provider did not answer.");
    });

    const human = await doctor(["--repo", fixture.repository, "--live"]);
    expect(human.exitCode).toBe(1);
    expect(human.text).toContain("provider=failed");
    expect(human.text).toContain("Code: provider-live-unavailable");
    expect(human.text).not.toContain(LIVE_LINES["not-requested"]);

    const json = await doctor(["--repo", fixture.repository, "--live", "--json"]);
    expect(JSON.parse(json.text).liveConnectivity.provider).toBe("failed");
    expect(calls.provider).toBe(2);
    expect(injected.liveDiagnoseCalls).toBe(0);
  });

  it("reports a check that offline readiness kept from running as not attempted", async () => {
    const { fixture, calls } = await liveFixture(async () => ({ live: { latencyMs: 7 } }));
    const gitMissing: DoctorReadinessCommandRunner = {
      run: async (command, args) =>
        command === "git" && args[0] === "--version"
          ? { exitCode: 1, stdout: "" }
          : fixture.commands.run(command, args),
      probeCredential: async () => fixture.commands.probeCredential(),
    };
    injected.options = { ...injected.options, commands: gitMissing };

    const human = await doctor(["--repo", fixture.repository, "--live"]);
    expect(human.exitCode).toBe(1);
    expect(human.text).toContain("provider=not-attempted");
    expect(human.text).not.toContain(LIVE_LINES["not-requested"]);
    const json = await doctor(["--repo", fixture.repository, "--live", "--json"]);
    expect(JSON.parse(json.text).liveConnectivity.provider).toBe("not-attempted");
    expect(calls.provider).toBe(0);
  });

  it("still says the check was not requested without --live, and makes no live call", async () => {
    const { fixture, calls } = await liveFixture(async () => ({ live: { latencyMs: 7 } }));

    const human = await doctor(["--repo", fixture.repository]);
    expect(human.exitCode).toBe(0);
    expect(human.text).toContain(
      "Live connectivity: requested=false, provider=not-requested, gitlab=not-requested",
    );
    expect(human.text).toContain(LIVE_LINES["not-requested"]);
    expect(calls.provider).toBe(0);
    expect(injected.liveDiagnoseCalls).toBe(0);
  });
});

describe("the configuration block's live inference line", () => {
  const result: DoctorResult = {
    provider: validModelConfig.providerId,
    endpoint: validModelConfig.baseUrl,
    model: validModelConfig.modelId,
    skills: [],
    contextSources: [],
    profile: validModelConfig.profile,
    requestPolicy: validModelConfig.requestPolicy,
    retryPolicy: {
      maxRetries: 0,
      baseDelayMs: 1_000,
      maxDelayMs: 2_000,
      retryableCategories: ["timeout"],
    },
  };

  it.each(Object.entries(LIVE_LINES))(
    "renders the %s observation as its own line",
    (state, line) => {
      const rendered = formatDoctorResult({
        ...result,
        liveObservation: state as keyof typeof LIVE_LINES,
      }).split("\n");
      expect(rendered).toContain(line);
      for (const other of Object.values(LIVE_LINES)) {
        if (other !== line) expect(rendered).not.toContain(other);
      }
    },
  );

  it("keeps the measured latency when the result carries its own live check", () => {
    const rendered = formatDoctorResult({
      ...result,
      live: { latencyMs: 12 },
      liveObservation: "passed",
    }).split("\n");
    expect(rendered).toContain("Live inference: ready (12 ms)");
    expect(rendered).not.toContain(LIVE_LINES.passed);
  });
});
