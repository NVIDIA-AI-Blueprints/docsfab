// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The typed-shell contingency's spend gate at its shipped call site (#1707):
 * `docsfab doctor --live --answer-submission` through `handleDoctorCommand`,
 * with the probe stubbed at its module boundary so no request is sent. The
 * contingency is off unless the operator passes
 * `--answer-submission-typed-contingency`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleDoctorCommand } from "../src/cli/commands/doctor.js";
import { validModelConfig } from "./helpers.js";

const { probeCalls } = vi.hoisted(() => ({
  probeCalls: [] as Array<{ model: unknown; options: unknown }>,
}));

vi.mock("../src/doctor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/doctor.js")>()),
  probeConfiguredAnswerSubmission: async (model: unknown, options: unknown) => {
    probeCalls.push({ model, options });
    // `not-checked` writes no observation, so the command touches no state.
    return { decision: "not-checked", reason: "stubbed at the module boundary" };
  },
}));
vi.mock("../src/doctor-readiness.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/doctor-readiness.js")>()),
  inspectDoctorReadiness: async () => ({ status: "ready" }),
  formatDoctorReadiness: () => "DocsFab readiness: ready",
}));
vi.mock("../src/config/runtime-loader.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config/runtime-loader.js")>()),
  loadConfig: () => ({ model: validModelConfig, stateDirectory: "/nonexistent/docsfab/runs" }),
}));

let exitCode: typeof process.exitCode;
beforeEach(() => {
  exitCode = process.exitCode;
  probeCalls.length = 0;
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  process.exitCode = exitCode;
  vi.restoreAllMocks();
});

describe("docsfab doctor --live --answer-submission at the CLI", () => {
  it("runs the probe with the typed-shell contingency off unless the flag is given", async () => {
    await handleDoctorCommand(["--live", "--answer-submission"]);

    expect(probeCalls).toHaveLength(1);
    expect(probeCalls[0]!.model).toBe(validModelConfig);
    expect(probeCalls[0]!.options).toEqual({ typedContingency: false });
  });

  it("turns the contingency on only with --answer-submission-typed-contingency", async () => {
    await handleDoctorCommand([
      "--live",
      "--answer-submission",
      "--answer-submission-typed-contingency",
    ]);

    expect(probeCalls).toHaveLength(1);
    expect(probeCalls[0]!.options).toEqual({ typedContingency: true });
  });

  it("keeps the contingency off for --json too", async () => {
    await handleDoctorCommand(["--live", "--answer-submission", "--json"]);

    expect(probeCalls[0]!.options).toEqual({ typedContingency: false });
  });
});
