// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

const inspectDoctorReadiness = vi.hoisted(() => vi.fn());
const loadProfileInspectionConfig = vi.hoisted(() => vi.fn());
const diagnose = vi.hoisted(() => vi.fn());
const loadConfig = vi.hoisted(() => vi.fn());
const inspectModelProfile = vi.hoisted(() => vi.fn());
const formatModelProfileInspection = vi.hoisted(() => vi.fn());
const serializeModelProfileInspection = vi.hoisted(() => vi.fn());

vi.mock("../../config/runtime-loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/runtime-loader.js")>();
  return { ...actual, loadConfig };
});

vi.mock("../../doctor-readiness.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../doctor-readiness.js")>();
  return {
    ...actual,
    inspectDoctorReadiness,
  };
});

vi.mock("../profile-arguments.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../profile-arguments.js")>();
  return { ...actual, loadProfileInspectionConfig };
});

vi.mock("../../doctor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../doctor.js")>();
  return { ...actual, diagnose };
});

vi.mock("../../model/profile-inspection.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../model/profile-inspection.js")>();
  return {
    ...actual,
    inspectModelProfile,
    formatModelProfileInspection,
    serializeModelProfileInspection,
  };
});

import { handleDoctorCommand } from "./doctor.js";
import { describeDocsFabConfigurationSource } from "../../config/host-paths.js";
import type { DoctorReadinessResult } from "../../doctor-readiness.js";
import { unobservedDraftMrReadiness } from "../../doctor-publication-readiness.js";
import { parseModelEndpoint } from "../../model/configuration.js";

/** Colocated under `src`, so the fixture lives here rather than in `test/`. */
const clampedModelEnvironment = {
  MODEL_PROVIDER: "test-provider",
  MODEL_BASE_URL: "https://inference.example.test/v1/",
  MODEL_ID: "example/model",
  MODEL_API_FORMAT: "chat_completions",
  MODEL_API_KEY: "test-secret",
  MODEL_CONTEXT_WINDOW: "128000",
  MODEL_MAX_OUTPUT_TOKENS: "16384",
  MODEL_API_MIN_OUTPUT_TOKENS: "16",
  MODEL_CONTEXT_RESERVE_TOKENS: "4096",
  MODEL_REASONING: "true",
  MODEL_INPUT_TYPES: "text,image",
  MODEL_SUPPORTS_DEVELOPER_ROLE: "true",
  MODEL_SUPPORTS_REASONING_EFFORT: "true",
  MODEL_COMPATIBLE_API_FORMATS: "chat_completions",
  MODEL_INPUT_COST_PER_MILLION: "1.25",
  MODEL_OUTPUT_COST_PER_MILLION: "10",
  MODEL_CACHE_READ_COST_PER_MILLION: "0.5",
  MODEL_CACHE_WRITE_COST_PER_MILLION: "unknown",
  // Metadata that is not current; DocsFab must not invent an 8k lid.
  MODEL_PROFILE_APPROVED_SOURCE: "unknown",
  MODEL_PROFILE_EFFECTIVE_DATE: "unknown",
  MODEL_PROFILE_REVIEW_AFTER: "unknown",
};

const blocked: DoctorReadinessResult = {
  schemaVersion: 1,
  kind: "docsfab-doctor-readiness",
  status: "blocked",
  repositoryPath: "/repository",
  liveConnectivity: { requested: false, provider: "not-requested", gitlab: "not-requested" },
  endpointCompatibility: null,
  checks: [{ area: "provider", status: "blocked" }],
  diagnostics: [
    {
      area: "provider",
      code: "provider-credentials-missing",
      explanation: "The host-managed policy-provider credential is missing.",
      nextCommand: "docsfab setup",
    },
  ],
  validationCommand: "npm run check",
  checkoutBranch: null,
  checkoutRevision: null,
  gitlabTargetBranch: null,
  gitlabTargetRevision: null,
  draftMrReadiness: unobservedDraftMrReadiness(
    "blocked",
    "project-config-missing",
    "not observed in this fixture",
  ),
  remediationArgv: ["docsfab", "init", "--repo", "/repository"],
  repositoryRevision: "a".repeat(40),
  autoModesReady: [],
};

function expectDoctorStdoutOmitsConfigurationPaths(output: string): void {
  const source = describeDocsFabConfigurationSource();
  expect(output).not.toContain(source.configurationRoot);
  if (source.secretsFile !== null) {
    expect(output).not.toContain(source.secretsFile);
  }
  expect(output).not.toMatch(/^Configuration:/mu);
}

describe("doctor command missing-key NEXT", () => {
  const logs: string[] = [];
  const originalLog = console.log;

  afterEach(() => {
    console.log = originalLog;
    logs.length = 0;
    inspectDoctorReadiness.mockReset();
    process.exitCode = undefined;
  });

  it("prints the seed argv from readiness and does not invoke profile seed", async () => {
    inspectDoctorReadiness.mockResolvedValue(blocked);
    console.log = (message?: unknown) => {
      logs.push(String(message ?? ""));
    };
    await handleDoctorCommand([]);
    const output = logs.join("\n");
    expect(output).toContain("DocsFab doctor");
    expect(output).toContain("ATTENTION: The host-managed policy-provider credential is missing.");
    expectDoctorStdoutOmitsConfigurationPaths(output);
    expect(output).toContain("Next action: docsfab setup");
    expect(output).not.toMatch(/profile inspect/u);
    expect(output).not.toMatch(/--catalog/u);
    expect(inspectDoctorReadiness).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
  });

  it("uses the selected use for JSON output and the exit code", async () => {
    inspectDoctorReadiness.mockImplementation(async (options: { use?: string }) => ({
      ...blocked,
      selectedUse: options.use ?? "local-review",
      status: options.use === "draft-mr" ? "blocked" : "ready",
    }));
    console.log = (message?: unknown) => {
      logs.push(String(message ?? ""));
    };
    await handleDoctorCommand(["--json"]);
    expect(inspectDoctorReadiness).toHaveBeenCalledWith(
      expect.objectContaining({ use: undefined }),
    );
    expect(JSON.parse(logs[0]!)).toMatchObject({ selectedUse: "local-review", status: "ready" });
    expect(JSON.parse(logs[0]!)).not.toHaveProperty("validationScope");
    expect(process.exitCode).toBeUndefined();
    logs.length = 0;
    await handleDoctorCommand(["--use", "draft-mr", "--json"]);
    expect(JSON.parse(logs[0]!)).toMatchObject({ selectedUse: "draft-mr", status: "blocked" });
    expect(process.exitCode).toBe(1);
  });
});

describe("doctor catalog window reporting", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  const ready: DoctorReadinessResult = {
    ...blocked,
    status: "ready",
    checks: [{ area: "provider", status: "ready" }],
    diagnostics: [],
    validationScope: {
      readiness: "prerequisites-only",
      deliveryConfinement: "not-checked",
    },
  };
  const listedProfile = parseModelEndpoint(clampedModelEnvironment);

  afterEach(() => {
    console.log = originalLog;
    logs.length = 0;
    for (const spy of [
      inspectDoctorReadiness,
      loadProfileInspectionConfig,
      diagnose,
      inspectModelProfile,
      formatModelProfileInspection,
      serializeModelProfileInspection,
    ]) {
      spy.mockReset();
    }
    process.exitCode = undefined;
  });

  function arrangeCatalog(): void {
    inspectDoctorReadiness.mockResolvedValue(ready);
    loadProfileInspectionConfig.mockReturnValue({ model: listedProfile });
    diagnose.mockResolvedValue({ skills: [], contextSources: [] });
    inspectModelProfile.mockResolvedValue({ kind: "docsfab-model-profile-inspection" });
    formatModelProfileInspection.mockReturnValue("Profile inspection (fixture)");
    serializeModelProfileInspection.mockReturnValue('{"kind":"docsfab-model-profile-inspection"}');
    console.log = (message?: unknown) => {
      logs.push(String(message ?? ""));
    };
  }

  it("does not invent an 8k clamp on the human catalog surface", async () => {
    arrangeCatalog();
    await handleDoctorCommand(["--catalog"]);
    const output = logs.join("\n");
    expect(output.startsWith("DocsFab readiness: ready\n")).toBe(true);
    expectDoctorStdoutOmitsConfigurationPaths(output);
    expect(output).toContain("Limit clamps: none (no configured limit was reduced)");
    expect(output).toContain("Validation scope: prerequisites only");
    expect(output).toContain("Delivery confinement: not checked");
    expect(output).not.toContain("effective 8192 tokens");
  });

  it("carries an empty clamp list into the machine-readable catalog document", async () => {
    arrangeCatalog();
    await handleDoctorCommand(["--catalog", "--json"]);
    const output = logs.join("\n");
    const document = JSON.parse(output) as {
      limitClamps: Array<{ profile: string; field: string; message: string }>;
      readiness: DoctorReadinessResult;
    };
    expect(document.limitClamps).toEqual([]);
    expect(document.readiness.validationScope).toEqual(ready.validationScope);
    expectDoctorStdoutOmitsConfigurationPaths(output);
  });
});

describe("doctor retry envelope visibility", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  const ready: DoctorReadinessResult = {
    ...blocked,
    status: "ready",
    checks: [{ area: "provider", status: "ready" }],
    diagnostics: [],
  };

  afterEach(() => {
    console.log = originalLog;
    logs.length = 0;
    inspectDoctorReadiness.mockReset();
    loadConfig.mockReset();
    diagnose.mockReset();
    process.exitCode = undefined;
  });

  it("renders the offline CLI through its actual model binding without a fabricated timer", async () => {
    inspectDoctorReadiness.mockResolvedValue(ready);
    const model = parseModelEndpoint(clampedModelEnvironment);
    loadConfig.mockReturnValue({ model });
    diagnose.mockResolvedValue({
      provider: model.providerId,
      endpoint: model.baseUrl,
      model: model.modelId,
      profile: model.profile,
      requestPolicy: model.requestPolicy,
      retryPolicy: {
        maxRetries: 3,
        baseDelayMs: 1_000,
        maxDelayMs: 2_000,
        retryableCategories: ["timeout"],
      },
      skills: [],
      contextSources: [],
    });
    console.log = (message?: unknown) => {
      logs.push(String(message ?? ""));
    };

    await handleDoctorCommand([]);

    const normalOutput = logs.join("\n");
    expect(normalOutput).not.toContain("Retry envelope:");
    expect(normalOutput).not.toContain("Policy model:");
    expect(process.exitCode).toBeUndefined();

    logs.length = 0;
    await handleDoctorCommand(["--verbose"]);

    const verboseOutput = logs.join("\n");
    expect(verboseOutput).toContain("Retry envelope: attempts=4");
    expect(verboseOutput).toContain("attempt-timeout=not configured");
    expect(verboseOutput).toContain("judgment answer-now=not armed (no attempt timer)");
    expect(verboseOutput).toContain("workflow deadlines still apply");
    expect(verboseOutput).not.toContain("attempt-timeout=1800000ms");
    expect(verboseOutput).not.toContain("answer-now at 720000ms");
    expect(process.exitCode).toBeUndefined();
  });
});
