// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseDoctorArguments } from "../src/cli/profile-arguments.js";
import { limit, refuseLimit } from "../src/config/limits.js";
import { formatDoctorFailure, mapDoctorFailure } from "../src/doctor.js";
import { unobservedDraftMrReadiness } from "../src/doctor-publication-readiness.js";
import { formatDoctorReadiness, type DoctorReadinessResult } from "../src/doctor-readiness.js";
import {
  formatInitFailure,
  mapInitFailure,
  parseDocsFabInitArguments,
  type InitNextAction,
} from "../src/init.js";
import { ModelProfileMigrationError } from "../src/model/configuration.js";
import {
  formatRemediationLine,
  inferRemediationId,
  remediationText,
} from "../src/operator/remediation.js";
import {
  GlabThreatModelReviewApi,
  ThreatModelReviewHostError,
} from "../src/security/threat-model-reviews.js";

function readiness(diagnostics: DoctorReadinessResult["diagnostics"]): DoctorReadinessResult {
  return {
    schemaVersion: 1,
    kind: "docsfab-doctor-readiness",
    status: "blocked",
    liveConnectivity: {
      requested: false,
      provider: "not-requested",
      gitlab: "not-requested",
    },
    checks: [
      { area: "installation", status: "ready" },
      { area: "configuration", status: "ready" },
      { area: "repository", status: "ready" },
      { area: "provider", status: "blocked" },
      { area: "gitlab", status: "blocked" },
      { area: "private-state", status: "ready" },
      { area: "validation", status: "ready" },
    ],
    diagnostics,
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
    repositoryPath: null,
    autoModesReady: [],
  };
}

describe("doctor and init remediation alignment", () => {
  it("routes only the typed missing primary credential reason to setup", () => {
    const missingPrimaryCredential = new ModelProfileMigrationError([
      {
        profile: "MODEL",
        field: "MODEL_API_KEY",
        message: "missing required environment variable",
      },
    ]);
    expect(missingPrimaryCredential.reason).toBe("missing-primary-credential");
    expect(inferRemediationId(missingPrimaryCredential)).toBe("profile-setup");
    expect(remediationText(inferRemediationId(missingPrimaryCredential)!)).toBe("docsfab setup");

    const malformed = new ModelProfileMigrationError([
      { profile: "MODEL", field: "MODEL_API_KEY", message: "malformed credential source" },
    ]);
    expect(malformed.reason).toBe("invalid-profile");
    expect(inferRemediationId(malformed)).toBe("profile-inspect");
  });

  it("uses the same glab-auth-login wording for doctor readiness and init", () => {
    const shared = remediationText("glab-auth-login");
    const doctor = readiness([
      {
        area: "gitlab",
        code: "gitlab-login-missing",
        explanation: "No host-managed GitLab credential is available for the repository host.",
        nextCommand: shared,
      },
    ]);
    const formatted = formatDoctorReadiness(doctor);
    expect(formatted).toContain(`Next action: ${shared}`);
    expect(formatRemediationLine("glab-auth-login")).toBe(`Next action: ${shared}`);

    const initActions: InitNextAction[] = ["glab-auth-login"];
    expect(formatRemediationLine(initActions[0]!)).toContain(shared);
    expect(shared).toMatch(/glab auth login/u);
    expect(shared).not.toMatch(/token|password|api[_-]?key/iu);
  });

  it("uses the same profile-inspect wording across doctor and init failure paths", () => {
    const shared = remediationText("profile-inspect");
    const doctor = readiness([
      {
        area: "provider",
        code: "provider-credentials-missing",
        explanation: "The host-managed policy-provider credential is missing.",
        nextCommand: shared,
      },
    ]);
    expect(formatDoctorReadiness(doctor)).toContain(`Next action: ${shared}`);

    const profileError = new Error("MODEL_API_KEY is missing for profile inspection.");
    expect(mapInitFailure(profileError).nextAction).toBe(shared);
    expect(formatInitFailure(profileError)).toContain(`Next action: ${shared}`);

    const doctorEnvelope = mapDoctorFailure(profileError);
    expect(doctorEnvelope.nextAction).toBe(shared);
    expect(formatDoctorFailure(profileError)).toContain(`Next action: ${shared}`);
  });

  it("routes only model-profile setting names, not a longer name containing MODEL_, to profile inspect", () => {
    const hostRequired = (() => {
      try {
        new GlabThreatModelReviewApi("/tmp", "gitlab.example.com", "packages/runtime", {});
      } catch (error) {
        return error;
      }
      throw new Error("expected the review host refusal");
    })();
    expect(hostRequired).toBeInstanceOf(ThreatModelReviewHostError);
    expect((hostRequired as Error).message).toContain("DOCSFAB_THREAT_MODEL_REVIEW_GITLAB_HOST");
    expect(inferRemediationId(hostRequired)).toBeUndefined();
    expect(
      inferRemediationId(
        new ThreatModelReviewHostError(
          "Bound to gitlab.example.com (DOCSFAB_THREAT_MODEL_REVIEW_GITLAB_HOST).",
          "threat-model-review-host-mismatch",
        ),
      ),
    ).toBeUndefined();
    for (const message of [
      "MODEL_API_KEY is missing.",
      "Set `MODEL_BASE_URL` to an https endpoint.",
      "JUDGE_MODEL_ID is not set.",
      "Unsupported value in MODEL_ID.",
    ]) {
      expect(inferRemediationId(new Error(message)), message).toBe("profile-inspect");
    }
    // A limit refusal naming the catalog-model-count override carries its own remediation.
    const catalogModels = limit("nativePreflight.catalogModelCount", { environment: {} });
    const catalogRefusal = (() => {
      try {
        refuseLimit(catalogModels, catalogModels.value + 1);
      } catch (error) {
        return error;
      }
    })();
    expect((catalogRefusal as Error).message).toContain(
      "DOCSFAB_NATIVE_PREFLIGHT_CATALOG_MODEL_COUNT",
    );
    expect(inferRemediationId(catalogRefusal)).toBeUndefined();
  });

  it("keeps the retired doctor live-json refusal classified for older runtimes and saved logs", () => {
    // No current code emits this message, but `inferRemediationId` keeps
    // classifiers for failures from older installed runtimes or saved logs.
    const legacy = new Error(
      "doctor --live cannot use --json because live evidence has no schema-v1 envelope.",
    );
    expect(inferRemediationId(legacy)).toBe("cli-usage");
    expect(mapDoctorFailure(legacy).code).toBe("cli-usage");
    // The parser accepts the combination.
    expect(parseDoctorArguments(["--live", "--json"])).toMatchObject({ live: true, json: true });
  });

  it("refuses new message-regex remediation branches", () => {
    const source = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "../src/operator/remediation.ts"),
      "utf8",
    );
    const start = source.indexOf("export function inferRemediationId");
    const end = source.indexOf("export function doctorFallbackRemediationText");
    const inferrer = source.slice(start, end);
    const messageRegexes = [
      ...inferrer.matchAll(/\/(?:\\.|[^/\n])+\/[gimsuy]*\.test\(message\)/gu),
    ].map((match) => match[0]);
    expect(messageRegexes).toEqual([
      "/init --json requires|Unknown init option|duplicated init/iu.test(message)",
      "/unknown (?:or duplicated )?(?:doctor |test |profile )?option/iu.test(message)",
      "/requires --/iu.test(message)",
      "/cannot use --json/iu.test(message)",
      "/must not be duplicated/iu.test(message)",
      "/Unknown command/iu.test(message)",
      "/INFERENCE_HUB_METADATA/u.test(message)",
      "/glab auth|gitlab authentication|authentication is missing/iu.test(message)",
      "/gitlab project|project access/iu.test(message)",
      "/profile/iu.test(message)",
      "/\\b(?:MODEL|JUDGE)_/u.test(message)",
      "/doctor|readiness|configuration|private storage|journal/iu.test(message)",
    ]);
    expect(inferrer).not.toMatch(/\/profile\|doctor\|gitlab\//u);
  });

  it("keeps init JSON failures on the shared init-cli-usage remediation", () => {
    expect(() => parseDocsFabInitArguments(["--json"], "/tmp")).toThrow(
      /requires --non-interactive/u,
    );
    try {
      parseDocsFabInitArguments(["--json"], "/tmp");
    } catch (error) {
      expect(mapInitFailure(error).nextAction).toBe(remediationText("init-cli-usage"));
    }
  });
});
