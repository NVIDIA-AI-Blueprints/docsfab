// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { parseDoctorArguments } from "../src/cli/profile-arguments.js";
import { limitDefinition } from "../src/config/limits.js";
import { CONFIGURABLE_RETRY_CATEGORIES } from "../src/inference-attempt-taxonomy.js";
import type { DoctorReadinessResult } from "../src/doctor-readiness.js";
import type { DoctorResult } from "../src/doctor.js";
import { renderDoctorPresentation } from "../src/cli/doctor-presentation.js";
import { unobservedDraftMrReadiness } from "../src/doctor-publication-readiness.js";

const blockedReadiness: DoctorReadinessResult = {
  schemaVersion: 1,
  kind: "docsfab-doctor-readiness",
  status: "blocked",
  selectedUse: "local-review",
  useReadiness: {
    "local-review": {
      status: "blocked",
      checks: [],
      diagnostics: [
        {
          area: "provider",
          code: "provider-credentials-missing",
          explanation: "The policy-provider credential is missing.",
          nextCommand: "docsfab setup",
        },
      ],
      blockers: ["provider-credentials-missing"],
    },
    "local-patch": { status: "ready", checks: [], diagnostics: [], blockers: [] },
    "draft-mr": { status: "ready", checks: [], diagnostics: [], blockers: [] },
  },
  repositoryPath: "/repository",
  liveConnectivity: { requested: false, provider: "not-requested", gitlab: "not-requested" },
  endpointCompatibility: null,
  checks: [],
  diagnostics: [
    {
      area: "configuration",
      code: "project-config-missing",
      explanation: "The project configuration is missing.",
      nextCommand: "docsfab init --repo /repository",
    },
    {
      area: "provider",
      code: "provider-credentials-missing",
      explanation: "The policy-provider credential is missing.",
      nextCommand: "docsfab setup",
    },
  ],
  validationCommand: null,
  repositoryRevision: null,
  checkoutBranch: null,
  checkoutRevision: null,
  gitlabTargetBranch: null,
  gitlabTargetRevision: null,
  draftMrReadiness: unobservedDraftMrReadiness("blocked", "project-config-missing", "not observed"),
  remediationArgv: null,
  autoModesReady: [],
};

const detailedDoctorResult = {
  provider: "fixture-provider",
  endpoint: "https://provider.example.test/v1",
  model: "fixture-model",
  skills: [],
  contextSources: [],
  profile: {
    effectiveLimitReason: "none",
    configuredLimits: { contextWindow: 4096, maxInputTokens: 2048, maxOutputTokens: 1024 },
    contextWindow: 4096,
    maxInputTokens: 2048,
    maxOutputTokens: 1024,
    reasoning: false,
    compatibility: {
      supportsDeveloperRole: true,
      supportsReasoningEffort: false,
      apiFormats: ["chat_completions"],
    },
    metadata: {
      status: "current",
      approvedSource: null,
      effectiveDate: "2026-01-01",
      reviewAfter: "2027-01-01",
    },
    costPerMillionTokens: { input: null, output: null, cacheRead: null, cacheWrite: null },
  },
  requestPolicy: { minimumOutputTokens: 1, reservedContextTokens: 0 },
  retryPolicy: {
    maxRetries: 2,
    baseDelayMs: 100,
    maxDelayMs: 1000,
    retryableCategories: CONFIGURABLE_RETRY_CATEGORIES.filter(
      (category) => category !== "no-progress",
    ),
  },
} as unknown as DoctorResult;

describe("doctor presentation arguments", () => {
  it("keeps the default shape unchanged and records explicit human modes", () => {
    expect(parseDoctorArguments([])).toMatchObject({
      live: false,
      catalog: false,
      purpose: "policy",
      json: false,
    });
    expect(parseDoctorArguments(["--quiet"])).toMatchObject({ quiet: true });
    expect(parseDoctorArguments(["--verbose"])).toMatchObject({ verbose: true });
  });

  it("keeps JSON canonical when quiet is also requested", () => {
    expect(parseDoctorArguments(["--quiet", "--json"])).toMatchObject({
      quiet: true,
      json: true,
    });
  });

  it("rejects conflicting human modes and a verbose machine request", () => {
    expect(() => parseDoctorArguments(["--quiet", "--verbose"])).toThrow(/cannot be combined/u);
    expect(() => parseDoctorArguments(["--verbose", "--json"])).toThrow(/cannot be combined/u);
  });

  it("keeps explicit catalog and probe output dialects independent", () => {
    expect(() => parseDoctorArguments(["--quiet", "--catalog"])).toThrow(
      /explicit inspections and probes keep their own output/u,
    );
    expect(() => parseDoctorArguments(["--verbose", "--answer-records"])).toThrow(
      /explicit inspections and probes keep their own output/u,
    );
  });

  it("continues to reject duplicate presentation flags", () => {
    expect(() => parseDoctorArguments(["--quiet", "--quiet"])).toThrow(/duplicated/u);
    expect(() => parseDoctorArguments(["--verbose", "--verbose"])).toThrow(/duplicated/u);
  });

  it("keeps selected readiness evidence in normal output and all uses in verbose mode", () => {
    const normal = renderDoctorPresentation({ readiness: blockedReadiness }).stdout;
    const quiet = renderDoctorPresentation({ readiness: blockedReadiness, detail: "quiet" }).stdout;
    const verbose = renderDoctorPresentation({
      readiness: blockedReadiness,
      detail: "verbose",
    }).stdout;

    expect(normal).toContain("blocked for local-review");
    expect(normal).toContain("ATTENTION: The policy-provider credential is missing.");
    expect(normal).toContain("Next action: docsfab setup");
    expect(normal).toContain("Explanation: The policy-provider credential is missing.");
    expect(normal).not.toContain("docsfab init");
    expect(normal).toContain(
      "Details: 'docsfab' 'doctor' '--repo' '/repository' '--use' 'local-review' '--verbose'",
    );
    expect(normal).not.toContain("local-patch readiness");
    expect(normal).not.toContain("Doctor details");
    expect(quiet).not.toContain("Details:");
    expect(quiet).not.toContain("Live connectivity:");
    expect(quiet).not.toContain("Doctor details");
    expect(verbose).toContain("Doctor details");
    expect(verbose).toContain("Live connectivity: requested=false");
    expect(verbose).toContain("provider-credentials-missing");
    for (const output of [normal, quiet, verbose]) {
      expect(output).toContain("Validation scope: not reported");
      expect(output).toContain("Delivery confinement: not reported");
      expect(output).not.toContain("Delivery confinement: not checked");
    }
  });

  it("keeps the default result concise and makes routine diagnostics verbose-only", () => {
    const normal = renderDoctorPresentation({
      readiness: blockedReadiness,
      result: detailedDoctorResult,
    }).stdout;
    const verbose = renderDoctorPresentation({
      readiness: blockedReadiness,
      result: detailedDoctorResult,
      detail: "verbose",
    }).stdout;

    expect(normal).toContain("DocsFab configuration: ready");
    expect(normal).not.toContain("Read-only retry policy:");
    expect(normal).not.toContain("Policy model:");
    expect(normal).not.toContain("fixture-model");
    expect(verbose).toContain("Read-only retry policy:");
    expect(verbose).toContain("Policy model:");
    expect(verbose).toContain("fixture-model");
  });

  it("keeps optional draft-MR blockers separate from a usable selected local review", () => {
    const readiness: DoctorReadinessResult = {
      ...blockedReadiness,
      status: "ready",
      diagnostics: [],
      useReadiness: {
        ...blockedReadiness.useReadiness!,
        "local-review": { status: "ready", checks: [], diagnostics: [], blockers: [] },
        "draft-mr": {
          status: "blocked",
          checks: [],
          diagnostics: [
            {
              area: "gitlab",
              code: "gitlab-login-missing",
              explanation: "GitLab login is needed only to prepare a draft MR.",
              nextCommand: "glab auth login",
            },
          ],
          blockers: ["gitlab-login-missing"],
        },
      },
    };
    const output = renderDoctorPresentation({ readiness }).stdout;

    expect(output).toContain("ready for local-review");
    expect(output).toContain("optional draft-MR readiness is blocked");
    expect(output).toContain("Optional draft-MR blocker: gitlab-login-missing");
    expect(output).toContain(
      "Optional draft-MR explanation: GitLab login is needed only to prepare a draft MR.",
    );
    expect(output).toContain("Optional draft-MR next action: glab auth login");
    expect(output).toContain("Continue: 'docsfab' 'list'");
    expect(output).not.toContain("Prepare draft MR");
  });

  it("keeps live failures visible alongside optional draft-MR blockers", () => {
    const readiness: DoctorReadinessResult = {
      ...blockedReadiness,
      status: "ready",
      liveConnectivity: { requested: true, provider: "failed", gitlab: "not-requested" },
      diagnostics: [],
      useReadiness: {
        ...blockedReadiness.useReadiness!,
        "local-review": { status: "ready", checks: [], diagnostics: [], blockers: [] },
        "local-patch": { status: "ready", checks: [], diagnostics: [], blockers: [] },
        "draft-mr": {
          status: "blocked",
          checks: [],
          diagnostics: [
            {
              area: "gitlab",
              code: "gitlab-login-missing",
              explanation: "GitLab login is needed only to prepare a draft MR.",
              nextCommand: "glab auth login",
            },
          ],
          blockers: ["gitlab-login-missing"],
        },
      },
    };
    const result = {
      ...detailedDoctorResult,
      liveObservation: "failed",
    } as unknown as DoctorResult;
    for (const detail of ["normal", "quiet"] as const) {
      const output = renderDoctorPresentation({ readiness, result, detail }).stdout.replaceAll(
        /\s+/gu,
        " ",
      );

      expect(output).toContain("optional draft-MR readiness is blocked");
      expect(output).toContain(
        "Live connectivity: requested=true, provider=failed, gitlab=not-requested",
      );
      expect(output).toContain(
        "Live inference: failed (checked by --live; see the provider diagnostic)",
      );
    }
  });

  it("keeps actionable limits and unreadable host/session state visible in quiet output", () => {
    const readiness: DoctorReadinessResult = {
      ...blockedReadiness,
      status: "ready",
      diagnostics: [],
      limitations: [
        {
          code: "native-lint-platform-unavailable",
          explanation: "Native review lint is unavailable on this platform.",
          nextCommand: "Rerun the review on Linux.",
        },
      ],
      hostLimitsFile: {
        code: "host-limits-file-unreadable",
        path: "/etc/docsfab/host-limits.yaml",
        reason: "EACCES",
        remediation: "Allow the operator to read the host limits file.",
      },
      liveAgentSessions: {
        state: "unreadable",
        sessions: 0,
        bytes: 0,
        oldestAgeDays: null,
        taskBranchStates: 0,
        maxAgeDays: 30,
        code: "live-agent-storage-unreadable",
      },
      useReadiness: {
        ...blockedReadiness.useReadiness!,
        "local-review": { status: "ready", checks: [], diagnostics: [], blockers: [] },
        "local-patch": { status: "ready", checks: [], diagnostics: [], blockers: [] },
        "draft-mr": { status: "ready", checks: [], diagnostics: [], blockers: [] },
      },
    };
    const result = {
      ...detailedDoctorResult,
      profile: { ...detailedDoctorResult.profile, effectiveLimitReason: "composition-candidate" },
    } as unknown as DoctorResult;
    const normal = renderDoctorPresentation({ readiness, result }).stdout;
    const quiet = renderDoctorPresentation({ readiness, result, detail: "quiet" }).stdout;
    const verbose = renderDoctorPresentation({ readiness, result, detail: "verbose" }).stdout;

    for (const output of [normal, quiet]) {
      expect(output).toContain("LIMITATION native-lint-platform-unavailable:");
      expect(output).toContain("Rerun the review on Linux.");
      expect(output).toContain(
        "Host limits file: skipped /etc/docsfab/host-limits.yaml (host-limits-file-unreadable, EACCES).",
      );
      expect(output).toContain("Live-agent sessions: unreadable (live-agent-storage-unreadable)");
      expect(output).toContain("Limit reason: composition-candidate");
      expect(output.replaceAll(/\s+/gu, " ")).toContain(
        "Retry categories: the configured list is the former default",
      );
      expect(output).not.toContain("Read-only retry policy:");
    }
    expect(verbose).toContain("Read-only retry policy:");
  });

  it("keeps configured credential comparison warnings visible at every detail level", () => {
    const minimum = limitDefinition("secrets.configuredCredentialMinChars");
    const readiness: DoctorReadinessResult = {
      ...blockedReadiness,
      configuredCredentialsNotCompared: [
        {
          source: "environment variable X_PASSWORD",
          rule: "shorter-than-minimum",
          limit: minimum.name,
          limitValue: minimum.value,
          override: minimum.override,
          lowestValue: minimum.min,
        },
      ],
    };
    const outputs = (["normal", "quiet", "verbose"] as const).map(
      (detail) => renderDoctorPresentation({ readiness, detail }).stdout,
    );

    for (const output of outputs) {
      expect(output).toContain(
        "Configured credential not compared: environment variable X_PASSWORD",
      );
      expect(output).not.toContain("credential-value");
    }
  });
});
