// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { unobservedDraftMrReadiness } from "../src/doctor-publication-readiness.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it, vi } from "vitest";

import { inspectAcceptanceExportDoctor } from "../src/acceptance-export-doctor.js";
import {
  offlineAcceptanceEnvironment,
  sanitizeAcceptancePhaseOutput,
  summarizeNetworkedPhaseFailure,
  type AcceptanceCommand,
} from "../src/acceptance.js";
import { authenticateAcceptanceExport, executeCommand } from "../src/acceptance-cli.js";
import type { DocsFabConfig } from "../src/config/runtime-loader.js";
import type { DoctorResult } from "../src/doctor.js";
import type { DoctorReadinessArea, DoctorReadinessResult } from "../src/doctor-readiness.js";
import { reportOperatorFailure } from "../src/operator/error-envelope.js";
import { remediationText } from "../src/operator/remediation.js";
import { validModelConfig } from "./helpers.js";
import { temporaryRoots } from "./helpers/temp.js";
import { nestedDeadlineMs, testTimeoutMs } from "./helpers/test-timeouts.js";
import { commitFixture, git, initFixtureRepo, type FixtureFiles } from "./helpers/git.js";

/**
 * The doctor's own readiness inspection, observed where the export doctor calls
 * it: each call's options, and a readiness to return instead of inspecting.
 */
const defaultInspection = vi.hoisted(() => ({
  calls: [] as Array<{ cwd: string | undefined; live: boolean | undefined }>,
  readiness: undefined as unknown,
}));
vi.mock("../src/doctor-readiness.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/doctor-readiness.js")>();
  return {
    ...actual,
    inspectDoctorReadiness: async (
      options?: Parameters<typeof actual.inspectDoctorReadiness>[0],
    ): ReturnType<typeof actual.inspectDoctorReadiness> => {
      defaultInspection.calls.push({ cwd: options?.cwd, live: options?.live });
      return (
        (defaultInspection.readiness as DoctorReadinessResult | undefined) ??
        actual.inspectDoctorReadiness(options)
      );
    },
  };
});

const execute = promisify(execFile);
const roots = temporaryRoots();
const testedRevision = "a".repeat(40);
const testedTree = "b".repeat(40);
const exportRevision = "c".repeat(40);
const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const exportDoctorEntry = join(runtimeRoot, "src", "acceptance-export-doctor.ts");
const tsxLoader = fileURLToPath(import.meta.resolve("tsx"));
// Local budgets in ms. In CI each case gets at least test.ciTimeoutMs from
// config/limits.yaml, and the doctor child keeps its local share of that
// budget so it still fails first.
const localExportDoctorProcessMs = 30_000;
const localExportDoctorCaseMs = 45_000;

/** The readiness the export doctor expects: the doctor's default local-review use, ready. */
function readiness(overrides: Partial<DoctorReadinessResult> = {}): DoctorReadinessResult {
  return {
    schemaVersion: 1,
    kind: "docsfab-doctor-readiness",
    status: "ready",
    selectedUse: "local-review",
    liveConnectivity: {
      requested: false,
      provider: "not-requested",
      gitlab: "not-requested",
    },
    endpointCompatibility: null,
    checks: (
      ["installation", "configuration", "repository", "provider", "validation"] as const
    ).map((area) => ({ area, status: "ready" as const })),
    diagnostics: [],
    validationCommand: null,
    checkoutBranch: "acceptance-export",
    checkoutRevision: exportRevision,
    gitlabTargetBranch: null,
    gitlabTargetRevision: null,
    draftMrReadiness: unobservedDraftMrReadiness(
      "blocked",
      "gitlab-project-mismatch",
      "not observed in this fixture",
    ),
    remediationArgv: null,
    repositoryRevision: exportRevision,
    autoModesReady: ["dry-run", "patch-only"],
    ...overrides,
    repositoryPath: overrides.repositoryPath ?? null,
  };
}

/**
 * Seven checks, a blocked configuration, `project-config-missing` and a
 * validation command: a shape the local-review inspection never reports.
 */
function sevenCheckMissingConfigReadiness(): DoctorReadinessResult {
  return readiness({
    status: "blocked",
    checks: [
      { area: "installation", status: "ready" },
      { area: "configuration", status: "blocked" },
      { area: "repository", status: "ready" },
      { area: "provider", status: "ready" },
      { area: "gitlab", status: "blocked" },
      { area: "private-state", status: "blocked" },
      { area: "validation", status: "ready" },
    ],
    diagnostics: [
      {
        area: "configuration",
        code: "project-config-missing",
        explanation: "missing",
        nextCommand: "docsfab init",
      },
    ],
    validationCommand: "npm run check",
    autoModesReady: [],
  });
}

const REFUSAL = "Acceptance export doctor found an unexpected governed disposition.";
const DIFFERENCES = "Differences from the expected readiness:";
/** The stable code of that refusal; a networked phase's summary keeps it in place of the message. */
const REFUSAL_CODE = "acceptance-export-disposition-unexpected";
const SEVEN_CHECK_DIFFERENCES = [
  "- status: observed blocked, expected ready",
  "- configuration check: observed blocked, expected ready",
  "- gitlab check: observed blocked, expected absent",
  "- private-state check: observed blocked, expected absent",
  "- diagnostic codes: observed [project-config-missing], expected []",
  "- validation command: observed npm run check, expected none",
  "- auto modes ready: observed 0 [], expected 2 [dry-run, patch-only]",
];

/** The refusal message for one readiness shape; fails the test if the doctor accepts it. */
async function refusalMessage(
  shape: DoctorReadinessResult,
  tree: string = testedTree,
): Promise<string> {
  const outcome = await inspectAcceptanceExportDoctor(
    {
      cwd: "/private/export",
      expectedRevision: testedRevision,
      expectedTree: testedTree,
      live: false,
    },
    { inspectReadiness: async () => shape, readTree: async () => tree },
  ).then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!(outcome instanceof Error))
    throw new Error("The export doctor accepted the readiness shape.");
  return outcome.message;
}

describe("acceptance export doctor", () => {
  it("authenticates the exact tree and the export's local-review readiness", async () => {
    const result = await inspectAcceptanceExportDoctor(
      {
        cwd: "/private/export",
        expectedRevision: testedRevision,
        expectedTree: testedTree,
        live: false,
      },
      {
        inspectReadiness: async () => readiness(),
        readTree: async () => testedTree,
      },
    );

    expect(result).toEqual({
      schemaVersion: 2,
      kind: "docsfab-acceptance-export-doctor",
      testedRevision,
      testedTree,
      exportRevision,
      readiness: "local-review-ready",
      provider: "offline-ready",
    });
  });

  it("accepts publication advice but refuses a classified local-review blocker", async () => {
    const base = readiness();
    const advice = {
      area: "gitlab" as const,
      code: "runtime-glab-missing" as const,
      explanation: "GitLab CLI unavailable for publication.",
      nextCommand: "Install glab before publishing.",
    };
    const views = {
      "local-review": {
        status: "ready" as const,
        checks: base.checks,
        diagnostics: [advice],
        blockers: [],
      },
      "local-patch": {
        status: "ready" as const,
        checks: base.checks,
        diagnostics: [advice],
        blockers: [],
      },
      "draft-mr": {
        status: "blocked" as const,
        checks: base.checks,
        diagnostics: [advice],
        blockers: [advice.code],
      },
    };
    const input = {
      cwd: "/private/export",
      expectedRevision: testedRevision,
      expectedTree: testedTree,
      live: false,
    };
    const accepted = await inspectAcceptanceExportDoctor(input, {
      inspectReadiness: async () => readiness({ diagnostics: [advice], useReadiness: views }),
      readTree: async () => testedTree,
    });
    expect(accepted.readiness).toBe("local-review-ready");

    const blocked = await refusalMessage(
      readiness({
        diagnostics: [advice],
        useReadiness: {
          ...views,
          "local-review": { ...views["local-review"], blockers: ["project-config-invalid"] },
        },
      }),
    );
    expect(blocked).toContain("- diagnostic codes: observed [project-config-invalid], expected []");
  });

  it("rejects an archive without authenticated Git state and names both differences", async () => {
    const message = await refusalMessage(
      readiness({
        repositoryRevision: null,
        diagnostics: [
          {
            area: "repository",
            code: "repository-unattached",
            explanation: "unattached",
            nextCommand: "cd <repository> && docsfab doctor",
          },
        ],
      }),
    );

    expect(message).toBe(
      [
        REFUSAL,
        DIFFERENCES,
        "- repository revision: observed none, expected an exact commit identity",
        "- diagnostic codes: observed [repository-unattached], expected []",
      ].join("\n"),
    );
  });

  it("refuses the seven-check missing-configuration shape and names each difference", async () => {
    expect(await refusalMessage(sevenCheckMissingConfigReadiness())).toBe(
      [REFUSAL, DIFFERENCES, ...SEVEN_CHECK_DIFFERENCES].join("\n"),
    );
  });

  it("rejects duplicate readiness checks even when their map projection looks exact", async () => {
    const base = readiness();
    await expect(
      inspectAcceptanceExportDoctor(
        {
          cwd: "/private/export",
          expectedRevision: testedRevision,
          expectedTree: testedTree,
          live: false,
        },
        {
          inspectReadiness: async () =>
            readiness({
              checks: [...base.checks, { area: "repository", status: "ready" }],
            }),
          readTree: async () => testedTree,
        },
      ),
    ).rejects.toThrow("- repository check: observed [ready, ready], expected ready");
  });

  it("names a differing area status and an extra diagnostic code when it refuses", async () => {
    const base = readiness();
    const message = await refusalMessage(
      readiness({
        checks: base.checks.map((check) =>
          check.area === "provider" ? { area: "provider", status: "blocked" } : check,
        ),
        diagnostics: [
          {
            area: "provider",
            code: "provider-credentials-missing",
            explanation: "The host-managed policy-provider credential is missing.",
            nextCommand: "docsfab setup",
          },
        ],
      }),
    );

    expect(message).toBe(
      [
        REFUSAL,
        DIFFERENCES,
        "- provider check: observed blocked, expected ready",
        "- diagnostic codes: observed [provider-credentials-missing], expected []",
      ].join("\n"),
    );
  });

  it("still accepts the expected shape when only fields it does not compare differ", async () => {
    const result = await inspectAcceptanceExportDoctor(
      {
        cwd: "/private/export",
        expectedRevision: testedRevision,
        expectedTree: testedTree,
        live: false,
      },
      {
        inspectReadiness: async () =>
          readiness({
            limitations: [
              {
                code: "native-lint-platform-unavailable",
                explanation: "Linux only.",
                nextCommand: "Rerun on Linux.",
              },
            ],
            repositoryPath: "/private/export",
            checkoutBranch: null,
            draftMrReadiness: unobservedDraftMrReadiness(
              "blocked",
              "runtime-glab-missing",
              "glab is not installed in this fixture",
            ),
            remediationArgv: ["glab", "--version"],
          }),
        readTree: async () => testedTree,
      },
    );

    expect(result.readiness).toBe("local-review-ready");
    expect(result.exportRevision).toBe(exportRevision);
  });

  const expected = readiness();
  const notRequested: DoctorReadinessResult["liveConnectivity"] = {
    requested: false,
    provider: "not-requested",
    gitlab: "not-requested",
  };
  it.each<{
    name: string;
    shape: DoctorReadinessResult;
    tree?: string;
    line: string;
  }>([
    {
      name: "selected use",
      shape: readiness({ selectedUse: "draft-mr" }),
      line: "selected use: observed draft-mr, expected local-review",
    },
    {
      name: "absent selected use",
      shape: readiness({ selectedUse: undefined }),
      line: "selected use: observed none, expected local-review",
    },
    {
      name: "overall status",
      shape: readiness({ status: "blocked" }),
      line: "status: observed blocked, expected ready",
    },
    {
      name: "missing repository revision",
      shape: readiness({ repositoryRevision: null }),
      line: "repository revision: observed none, expected an exact commit identity",
    },
    {
      name: "invalid repository revision",
      shape: readiness({ repositoryRevision: "HEAD" }),
      line: "repository revision: observed an invalid identity, expected an exact commit identity",
    },
    {
      name: "export tree",
      shape: readiness(),
      tree: "d".repeat(40),
      line: "export tree: does not match the tested tree",
    },
    {
      name: "absent area",
      shape: readiness({
        checks: expected.checks.filter((check) => check.area !== "validation"),
      }),
      line: "validation check: observed absent, expected ready",
    },
    {
      name: "extra area",
      shape: readiness({
        checks: [...expected.checks, { area: "gitlab", status: "blocked" }],
      }),
      line: "gitlab check: observed blocked, expected absent",
    },
    {
      name: "unknown extra area",
      shape: readiness({
        checks: [...expected.checks, { area: "telemetry" as DoctorReadinessArea, status: "ready" }],
      }),
      line: "telemetry check: observed ready, expected absent",
    },
    {
      name: "duplicated area",
      shape: readiness({
        checks: [...expected.checks, { area: "repository", status: "ready" }],
      }),
      line: "repository check: observed [ready, ready], expected ready",
    },
    {
      name: "area status",
      shape: readiness({
        checks: expected.checks.map((check) =>
          check.area === "configuration" ? { area: "configuration", status: "blocked" } : check,
        ),
      }),
      line: "configuration check: observed blocked, expected ready",
    },
    {
      name: "advisory diagnostic",
      shape: readiness({
        diagnostics: [
          {
            area: "repository",
            code: "documentation-layout-unrecognized",
            explanation: "No recognized documentation directory.",
            nextCommand: "Keep documentation under docs/.",
          },
        ],
      }),
      line: "diagnostic codes: observed [documentation-layout-unrecognized], expected []",
    },
    {
      name: "validation command",
      shape: readiness({ validationCommand: "npm run check" }),
      line: "validation command: observed npm run check, expected none",
    },
    {
      name: "other validation command",
      shape: readiness({ validationCommand: "npm test" }),
      line: "validation command: observed npm test, expected none",
    },
    {
      name: "missing auto modes",
      shape: readiness({ autoModesReady: [] }),
      line: "auto modes ready: observed 0 [], expected 2 [dry-run, patch-only]",
    },
    {
      name: "extra auto mode",
      shape: readiness({ autoModesReady: ["dry-run", "patch-only", "draft-mr"] }),
      line: "auto modes ready: observed 3 [dry-run, patch-only, draft-mr], expected 2 [dry-run, patch-only]",
    },
    {
      name: "reordered auto modes",
      shape: readiness({ autoModesReady: ["patch-only", "dry-run"] }),
      line: "auto modes ready: observed 2 [patch-only, dry-run], expected 2 [dry-run, patch-only]",
    },
    {
      name: "requested live connectivity",
      shape: readiness({
        liveConnectivity: { ...notRequested, requested: true },
      }),
      line: "live connectivity requested: observed true, expected false",
    },
    {
      name: "unreported live request",
      shape: readiness({
        liveConnectivity: { ...notRequested, requested: undefined as unknown as boolean },
      }),
      line: "live connectivity requested: observed (unrecognized), expected false",
    },
    {
      name: "live provider connectivity",
      shape: readiness({
        liveConnectivity: { ...notRequested, provider: "passed" },
      }),
      line: "live connectivity provider: observed passed, expected not-requested",
    },
    {
      name: "live GitLab connectivity",
      shape: readiness({
        liveConnectivity: { ...notRequested, gitlab: "failed" },
      }),
      line: "live connectivity gitlab: observed failed, expected not-requested",
    },
  ])("refuses and names only the $name difference", async ({ shape, tree, line }) => {
    expect(await refusalMessage(shape, tree)).toBe([REFUSAL, DIFFERENCES, `- ${line}`].join("\n"));
  });

  it("names unrecognized values without echoing them or any diagnostic prose", async () => {
    const leak = "/home/operator/.config/docsfab Private Detail";
    const message = await refusalMessage(
      readiness({
        selectedUse: leak as "local-review",
        status: leak as "ready",
        checks: [
          ...expected.checks.filter((check) => check.area !== "repository"),
          { area: "repository", status: leak as "ready" },
        ],
        diagnostics: [
          {
            area: "configuration",
            code: leak as "project-config-invalid",
            explanation: `explanation prose ${leak}`,
            nextCommand: `next command ${leak}`,
          },
        ],
        validationCommand: leak as "npm test",
        liveConnectivity: { ...notRequested, requested: leak as unknown as boolean },
      }),
    );

    expect(message).toBe(
      [
        REFUSAL,
        DIFFERENCES,
        "- selected use: observed (unrecognized), expected local-review",
        "- status: observed (unrecognized), expected ready",
        "- repository check: observed (unrecognized), expected ready",
        "- diagnostic codes: observed [(unrecognized)], expected []",
        "- validation command: observed (unrecognized), expected none",
        "- live connectivity requested: observed (unrecognized), expected false",
      ].join("\n"),
    );
    for (const fragment of ["/home", "Private Detail", "explanation prose", "next command"]) {
      expect(message).not.toContain(fragment);
    }
  });

  // Starts with a vocabulary term, so only the vocabulary pattern's end anchor refuses it.
  const prefixed = "ready Private Detail /home/operator/.config/docsfab";
  it.each<{ name: string; shape: DoctorReadinessResult; line: string }>([
    {
      name: "selected use",
      shape: readiness({ selectedUse: prefixed as "local-review" }),
      line: "selected use: observed (unrecognized), expected local-review",
    },
    {
      name: "overall status",
      shape: readiness({ status: prefixed as "ready" }),
      line: "status: observed (unrecognized), expected ready",
    },
    {
      name: "expected area status",
      shape: readiness({
        checks: expected.checks.map((check) =>
          check.area === "repository" ? { area: "repository", status: prefixed as "ready" } : check,
        ),
      }),
      line: "repository check: observed (unrecognized), expected ready",
    },
    {
      name: "duplicated area statuses",
      shape: readiness({
        checks: [...expected.checks, { area: "repository", status: prefixed as "ready" }],
      }),
      line: "repository check: observed [ready, (unrecognized)], expected ready",
    },
    {
      name: "extra area name",
      shape: readiness({
        checks: [...expected.checks, { area: prefixed as DoctorReadinessArea, status: "ready" }],
      }),
      line: "(unrecognized) check: observed ready, expected absent",
    },
    {
      name: "extra area status",
      shape: readiness({
        checks: [...expected.checks, { area: "gitlab", status: prefixed as "ready" }],
      }),
      line: "gitlab check: observed (unrecognized), expected absent",
    },
    {
      name: "diagnostic code",
      shape: readiness({
        diagnostics: [
          {
            area: "repository",
            code: prefixed as "repository-unattached",
            explanation: "unattached",
            nextCommand: "docsfab doctor",
          },
        ],
      }),
      line: "diagnostic codes: observed [(unrecognized)], expected []",
    },
    {
      name: "validation command",
      shape: readiness({ validationCommand: prefixed as "npm test" }),
      line: "validation command: observed (unrecognized), expected none",
    },
    {
      name: "observed auto mode",
      shape: readiness({ autoModesReady: ["dry-run", prefixed as "patch-only"] }),
      line: "auto modes ready: observed 2 [dry-run, (unrecognized)], expected 2 [dry-run, patch-only]",
    },
    {
      name: "live connectivity request",
      shape: readiness({
        liveConnectivity: { ...notRequested, requested: prefixed as unknown as boolean },
      }),
      line: "live connectivity requested: observed (unrecognized), expected false",
    },
    {
      name: "live provider value",
      shape: readiness({
        liveConnectivity: { ...notRequested, provider: prefixed as "passed" },
      }),
      line: "live connectivity provider: observed (unrecognized), expected not-requested",
    },
    {
      name: "live GitLab value",
      shape: readiness({
        liveConnectivity: { ...notRequested, gitlab: prefixed as "failed" },
      }),
      line: "live connectivity gitlab: observed (unrecognized), expected not-requested",
    },
  ])("names an out-of-vocabulary $name as (unrecognized)", async ({ shape, line }) => {
    const message = await refusalMessage(shape);

    expect(message).toBe([REFUSAL, DIFFERENCES, `- ${line}`].join("\n"));
    for (const fragment of ["Private Detail", "/home", ".config"]) {
      expect(message).not.toContain(fragment);
    }
  });

  it("inspects the export's readiness offline even when it then probes the live provider", async () => {
    defaultInspection.calls.length = 0;
    defaultInspection.readiness = readiness();
    try {
      let liveProbes = 0;
      const result = await inspectAcceptanceExportDoctor(
        {
          cwd: "/private/export",
          expectedRevision: testedRevision,
          expectedTree: testedTree,
          live: true,
        },
        {
          readTree: async () => testedTree,
          loadConfiguration: () => ({ model: validModelConfig }) as DocsFabConfig,
          diagnoseConfiguration: async (_config, live) => {
            liveProbes += 1;
            expect(live).toBe(true);
            return { live: { latencyMs: 1 } } as DoctorResult;
          },
        },
      );

      // The doctor's own inspection ran once, requesting no live connectivity.
      expect(defaultInspection.calls).toEqual([{ cwd: "/private/export", live: false }]);
      // Positive control: the separately approved provider probe still ran.
      expect(liveProbes).toBe(1);
      expect(result.provider).toBe("live-ready");
    } finally {
      defaultInspection.readiness = undefined;
    }
  });

  it("keeps the named differences through the failure envelope and the phase-output sanitizer", async () => {
    const error = await inspectAcceptanceExportDoctor(
      {
        cwd: "/private/export",
        expectedRevision: testedRevision,
        expectedTree: testedTree,
        live: false,
      },
      {
        inspectReadiness: async () => sevenCheckMissingConfigReadiness(),
        readTree: async () => testedTree,
      },
    ).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    const written: string[] = [];
    // The same boundary and options the doctor's entry point uses on failure.
    reportOperatorFailure(error, {
      json: false,
      write: (line) => written.push(line),
    });
    const output = `${written.join("\n")}\n`;

    expect(output.split("\n").slice(0, 11)).toEqual([
      REFUSAL,
      DIFFERENCES,
      ...SEVEN_CHECK_DIFFERENCES,
      `code: ${REFUSAL_CODE}`,
      "failure class: operator-input (layer cli)",
    ]);
    // The refusal names the `doctor` remediation itself, not the catch-all next action.
    expect(output).toContain(`\nNext action: ${remediationText("doctor")}\n`);
    expect(
      sanitizeAcceptancePhaseOutput(output, {
        environment: offlineAcceptanceEnvironment({}, "/operator/state/run"),
        privateRoots: ["/operator/state", "/operator/evidence"],
      }),
    ).toBe(output);
  });

  it("runs the live provider probe only after the exact export disposition passes", async () => {
    let liveCalls = 0;
    const config = { model: validModelConfig } as DocsFabConfig;
    const result = await inspectAcceptanceExportDoctor(
      {
        cwd: "/private/export",
        expectedRevision: testedRevision,
        expectedTree: testedTree,
        live: true,
      },
      {
        inspectReadiness: async () => readiness(),
        readTree: async () => testedTree,
        loadConfiguration: () => config,
        diagnoseConfiguration: async (_config, live) => {
          liveCalls += 1;
          expect(live).toBe(true);
          return { live: { latencyMs: 1 } } as DoctorResult;
        },
      },
    );

    expect(liveCalls).toBe(1);
    expect(result).toMatchObject({ readiness: "local-review-ready", provider: "live-ready" });
  });

  it("refuses the live doctor before any provider call when the readiness differs", async () => {
    let configurationLoads = 0;
    let liveCalls = 0;
    const refusal = await inspectAcceptanceExportDoctor(
      {
        cwd: "/private/export",
        expectedRevision: testedRevision,
        expectedTree: testedTree,
        live: true,
      },
      {
        inspectReadiness: async () => sevenCheckMissingConfigReadiness(),
        readTree: async () => testedTree,
        loadConfiguration: () => {
          configurationLoads += 1;
          return { model: validModelConfig } as DocsFabConfig;
        },
        diagnoseConfiguration: async () => {
          liveCalls += 1;
          return { live: { latencyMs: 1 } } as DoctorResult;
        },
      },
    ).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect((refusal as Error).message).toBe(
      [REFUSAL, DIFFERENCES, ...SEVEN_CHECK_DIFFERENCES].join("\n"),
    );
    expect(configurationLoads).toBe(0);
    expect(liveCalls).toBe(0);
  });

  it("names a live diagnosis that returns without a provider result in the networked summary", async () => {
    const input = {
      cwd: "/private/export",
      expectedRevision: testedRevision,
      expectedTree: testedTree,
      live: true,
    };
    const dependencies = {
      inspectReadiness: async () => readiness(),
      readTree: async () => testedTree,
      loadConfiguration: () => ({ model: validModelConfig }) as DocsFabConfig,
    };
    // Positive control: the same export passes when the diagnosis reports its live result.
    await expect(
      inspectAcceptanceExportDoctor(input, {
        ...dependencies,
        diagnoseConfiguration: async () => ({ live: { latencyMs: 1 } }) as DoctorResult,
      }),
    ).resolves.toMatchObject({ provider: "live-ready" });

    const error = await inspectAcceptanceExportDoctor(input, {
      ...dependencies,
      diagnoseConfiguration: async () => ({}) as DoctorResult,
    }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    const code = "acceptance-export-live-diagnosis-incomplete";
    expect(error).toMatchObject({
      code,
      message: "Acceptance export live provider diagnosis did not complete.",
    });
    const written: string[] = [];
    reportOperatorFailure(error, { json: true, write: (line) => written.push(line) });
    const summary = summarizeNetworkedPhaseFailure({
      acceptanceId: "acceptance-test",
      testedCommit: testedRevision,
      phase: "live-doctor",
      exitCode: 1,
      stdout: "",
      stderr: written.join("\n"),
      environment: {},
      privateRoots: [],
    });
    expect(summary).toEqual({
      schemaVersion: 1,
      acceptanceId: "acceptance-test",
      testedCommit: testedRevision,
      phase: "live-doctor",
      exitCode: 1,
      report: "operator-error",
      code,
      failure: { class: "contract-shape", layer: "cli", code },
      nextAction:
        "The live provider diagnosis returned without a provider result, which DocsFab does not expect. Run the acceptance again. If it stops the same way, report this DocsFab defect with the acceptance manifest.",
    });
    expect(JSON.stringify(summary)).not.toContain("did not complete");
  });
});

/** Pages shaped like this repository's export: a recognized `docs/` directory. */
const EXPORT_PAGES: FixtureFiles = {
  "README.md": "# Product\n",
  "docs/index.md": "# Product documentation\n\nInstall the product.\n",
};
const TRACKED_PROJECT_CONFIG = `${JSON.stringify(
  {
    documentationRoots: ["docs"],
    gitlab: { defaultBranch: "main", remote: "origin" },
    provider: { configuration: "host" },
    schemaVersion: 1,
    storage: { scope: "user-private" },
  },
  null,
  2,
)}\n`;

interface ExportFixture {
  root: string;
  repository: string;
  revision: string;
  tree: string;
}

/** A committed, clean repository on the export's branch, as `authenticateAcceptanceExport` leaves it. */
async function exportFixture(files: FixtureFiles): Promise<ExportFixture> {
  const root = await roots.create("docsfab-export-doctor-real-", { realpath: true });
  const repository = join(root, "source");
  const revision = await initFixtureRepo(repository, files, {
    branch: "acceptance-export",
    message: "authenticated acceptance export",
  });
  return { root, repository, revision, tree: await git(repository, ["rev-parse", "HEAD^{tree}"]) };
}

/**
 * Run the shipped entry point in the fixture the way the offline-doctor phase
 * does: the acceptance offline environment with a fresh home and temporary
 * directory, so the real readiness inspection runs end to end.
 */
async function runExportDoctor(
  fixture: ExportFixture,
  extraArguments: readonly string[] = [],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const home = join(fixture.root, "home");
  const temporary = join(fixture.root, "tmp");
  const state = join(fixture.root, "state");
  await Promise.all([home, temporary, state].map((directory) => mkdir(directory)));
  const environment: NodeJS.ProcessEnv = {
    ...offlineAcceptanceEnvironment({ PATH: process.env.PATH }, state),
    HOME: home,
    TMPDIR: temporary,
    PI_OFFLINE: "1",
    NODE_NO_WARNINGS: "1",
    DOCSFAB_ACCEPTANCE_EXPORT_DOCTOR: "true",
  };
  return await new Promise((resolve) => {
    execFile(
      process.execPath,
      [
        "--import",
        tsxLoader,
        exportDoctorEntry,
        "--expected-revision",
        testedRevision,
        "--expected-tree",
        fixture.tree,
        ...extraArguments,
      ],
      {
        cwd: fixture.repository,
        env: environment,
        encoding: "utf8",
        timeout: nestedDeadlineMs(localExportDoctorProcessMs, localExportDoctorCaseMs),
      },
      (error, stdout, stderr) =>
        resolve({
          code: error ? (typeof error.code === "number" ? error.code : null) : 0,
          stdout,
          stderr,
        }),
    );
  });
}

describe("acceptance export doctor on a real readiness inspection", () => {
  it("accepts the local-review readiness of an export that tracks .docsfab.json", {
    timeout: testTimeoutMs(localExportDoctorCaseMs),
  }, async () => {
    const fixture = await exportFixture({
      ...EXPORT_PAGES,
      ".docsfab.json": TRACKED_PROJECT_CONFIG,
    });

    const result = await runExportDoctor(fixture);

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: 2,
      kind: "docsfab-acceptance-export-doctor",
      testedRevision,
      testedTree: fixture.tree,
      exportRevision: fixture.revision,
      readiness: "local-review-ready",
      provider: "offline-ready",
    });
  });

  it("accepts the same readiness for an export that does not track .docsfab.json", {
    timeout: testTimeoutMs(localExportDoctorCaseMs),
  }, async () => {
    const fixture = await exportFixture(EXPORT_PAGES);

    const result = await runExportDoctor(fixture);

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({
      exportRevision: fixture.revision,
      readiness: "local-review-ready",
      provider: "offline-ready",
    });
  });

  it("refuses an export whose committed .docsfab.json is invalid and names each difference", {
    timeout: testTimeoutMs(localExportDoctorCaseMs),
  }, async () => {
    const fixture = await exportFixture({
      ...EXPORT_PAGES,
      ".docsfab.json": `${JSON.stringify({ schemaVersion: 99 })}\n`,
    });

    const result = await runExportDoctor(fixture);

    expect(result).toMatchObject({ code: 1, stdout: "" });
    expect(result.stderr.split("\n").slice(0, 7)).toEqual([
      REFUSAL,
      DIFFERENCES,
      "- status: observed blocked, expected ready",
      "- configuration check: observed blocked, expected ready",
      "- diagnostic codes: observed [project-config-invalid], expected []",
      "- auto modes ready: observed 0 [], expected 2 [dry-run, patch-only]",
      `code: ${REFUSAL_CODE}`,
    ]);
  });

  it("accepts --json and still prints its JSON result for an export that passes", {
    timeout: testTimeoutMs(localExportDoctorCaseMs),
  }, async () => {
    const fixture = await exportFixture({
      ...EXPORT_PAGES,
      ".docsfab.json": TRACKED_PROJECT_CONFIG,
    });

    const result = await runExportDoctor(fixture, ["--json"]);

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({
      exportRevision: fixture.revision,
      readiness: "local-review-ready",
      provider: "offline-ready",
    });
  });

  it("reports a live refusal as the JSON envelope a networked phase summary reads", {
    timeout: testTimeoutMs(localExportDoctorCaseMs),
  }, async () => {
    const fixture = await exportFixture({
      ...EXPORT_PAGES,
      ".docsfab.json": `${JSON.stringify({ schemaVersion: 99 })}\n`,
    });

    // The live doctor's arguments; the readiness refusal comes before any provider call.
    const result = await runExportDoctor(fixture, ["--live", "--json"]);

    expect(result).toMatchObject({ code: 1, stdout: "" });
    const envelope = JSON.parse(result.stderr) as { kind: string; code: string; message: string };
    expect(envelope).toMatchObject({ kind: "docsfab-operator-error", code: REFUSAL_CODE });
    // The refusal itself, not an option error.
    expect(envelope.message.split("\n").slice(0, 2)).toEqual([REFUSAL, DIFFERENCES]);
    const summary = summarizeNetworkedPhaseFailure({
      acceptanceId: "acceptance-test",
      testedCommit: testedRevision,
      phase: "live-doctor",
      exitCode: result.code ?? 1,
      stdout: result.stdout,
      stderr: result.stderr,
      environment: { MODEL_API_KEY: "offline-placeholder-not-a-credential" },
      privateRoots: [join(fixture.root, "state")],
    });
    expect(summary).toMatchObject({
      phase: "live-doctor",
      exitCode: 1,
      report: "operator-error",
      code: REFUSAL_CODE,
      failure: { class: "operator-input", layer: "cli", code: REFUSAL_CODE },
    });
    expect(JSON.stringify(summary)).not.toContain("governed disposition");
  });
});

describe("minimal authenticated acceptance export", () => {
  it("turns off automatic gc and maintenance in every export git command", async () => {
    const root = await roots.create("docsfab-acceptance-export-gc-");
    const source = join(root, "source");
    const workspace = join(root, "workspace");
    const archive = join(root, "source.tar");
    await mkdir(workspace);
    await initFixtureRepo(source, { "README.md": "export\n" }, { branch: "main", message: "only" });
    const tree = await git(source, ["rev-parse", "HEAD^{tree}"]);
    await git(source, ["archive", "--format=tar", `--output=${archive}`, "HEAD"]);
    await execute("tar", ["-xf", archive, "-C", workspace]);

    const commands: AcceptanceCommand[] = [];
    await authenticateAcceptanceExport({
      workspaceRoot: workspace,
      expectedTree: tree,
      objectFormat: "sha1",
      commandPrefix: [],
      environment: { PATH: process.env.PATH },
      execute: async (command, stream) => {
        commands.push(command);
        return executeCommand(command, stream);
      },
    });

    const pair = (args: readonly string[], setting: string): boolean =>
      args.some((arg, index) => arg === "-c" && args[index + 1] === setting);
    expect(commands.map((command) => command.file)).toEqual(commands.map(() => "git"));
    expect(commands.length).toBeGreaterThanOrEqual(9);
    for (const command of commands) {
      expect(pair(command.args, "gc.auto=0"), command.args.join(" ")).toBe(true);
      expect(pair(command.args, "maintenance.auto=false"), command.args.join(" ")).toBe(true);
    }
    expect(await git(workspace, ["config", "--get", "gc.auto"]).catch(() => "unset")).toBe("unset");
  });

  it("contains the exact current tree but no prior-history-only sentinel", async () => {
    const root = await roots.create("docsfab-acceptance-export-test-");
    const source = join(root, "source");
    const workspace = join(root, "workspace");
    const evidence = join(root, "evidence");
    const archive = join(root, "source.tar");
    await mkdir(workspace);
    await mkdir(evidence);
    await initFixtureRepo(
      source,
      { "prior-history-secret.txt": "prior-history-only-sentinel\n" },
      { branch: "main", message: "prior" },
    );
    await rm(join(source, "prior-history-secret.txt"));
    await writeFile(join(source, "package.json"), JSON.stringify({ scripts: { check: "true" } }));
    await commitFixture(source, "current");
    const tree = await git(source, ["rev-parse", "HEAD^{tree}"]);
    await git(source, ["archive", "--format=tar", `--output=${archive}`, "HEAD"]);
    await execute("tar", ["-xf", archive, "-C", workspace]);

    await authenticateAcceptanceExport({
      workspaceRoot: workspace,
      expectedTree: tree,
      objectFormat: "sha1",
      commandPrefix: [],
      environment: { PATH: process.env.PATH },
      execute: executeCommand,
    });

    await expect(
      readFile(join(workspace, "prior-history-secret.txt"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const objects = await git(workspace, ["rev-list", "--objects", "--all"]);
    expect(objects).not.toContain("prior-history-secret");
    const inventory = (
      await git(workspace, [
        "cat-file",
        "--batch-all-objects",
        "--batch-check=%(objectname) %(objecttype)",
      ])
    )
      .split("\n")
      .filter(Boolean);
    const blobContents = await Promise.all(
      inventory.flatMap((line) => {
        const [object, type] = line.split(" ");
        return type === "blob" && object ? [git(workspace, ["cat-file", "blob", object])] : [];
      }),
    );
    expect(blobContents.join("\n")).not.toContain("prior-history-only-sentinel");
    expect(await readdir(evidence)).toEqual([]);
    expect(await git(workspace, ["rev-parse", "HEAD^{tree}"])).toBe(tree);
  });
});
