// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { usage } from "../cli/usage.js";
import {
  doctorDiagnosticRemediation,
  formatRemediationLine,
  inferRemediationId,
  remediationIdForDoctorDiagnostic,
  remediationText,
} from "./remediation.js";

describe("doctor missing-key remediation", () => {
  it("points provider setup diagnostics at docsfab setup", () => {
    const next = remediationText("profile-setup");
    expect(next).toBe("docsfab setup");
    expect(usage()).toContain(next);
    expect(remediationIdForDoctorDiagnostic("provider-credentials-missing")).toBe("profile-setup");
    expect(remediationIdForDoctorDiagnostic("provider-configuration-invalid")).toBe(
      "profile-setup",
    );
    expect(remediationIdForDoctorDiagnostic("provider-profile-unapproved")).toBe("profile-setup");
    expect(
      doctorDiagnosticRemediation("provider-credentials-missing", "docsfab profile inspect"),
    ).toBe(next);
    expect(formatRemediationLine("profile-setup")).toBe(`Next action: ${next}`);
    expect(next).not.toMatch(/inspect|approve|\.env/u);
  });

  it("does not fold missing Metadata into inference missing-key or --catalog NEXT", () => {
    expect(remediationIdForDoctorDiagnostic("metadata-api-key-missing")).toBeUndefined();
    expect(remediationIdForDoctorDiagnostic("provider-credentials-missing")).toBe("profile-setup");
    expect(
      doctorDiagnosticRemediation("metadata-api-key-missing", "Catalog inspect remains optional."),
    ).toBe("Catalog inspect remains optional.");
    expect(
      doctorDiagnosticRemediation("metadata-api-key-missing", "Catalog inspect remains optional."),
    ).not.toMatch(/--catalog|unify|same key/iu);
    expect(
      inferRemediationId(new Error("INFERENCE_HUB_METADATA_API_KEY is unset.")),
    ).toBeUndefined();
    expect(
      inferRemediationId(new Error("MODEL_INFERENCE_HUB_METADATA_LABEL is missing.")),
    ).toBeUndefined();
  });

  it("keeps unavailable provider diagnostics on profile inspect", () => {
    expect(remediationIdForDoctorDiagnostic("provider-runtime-unavailable")).toBe(
      "profile-inspect",
    );
  });
});

describe("publication preflight code-keyed remediation", () => {
  it("directs legacy factory denial to a runtime update, not a different repository", () => {
    const factoryDenial = Object.assign(
      new Error(
        "Local-user GitLab publication preflight failed (factory-project-denied). Publish only to a non-factory GitLab project; the DocsFab factory is denied.",
      ),
      { code: "factory-project-denied" },
    );
    expect(inferRemediationId(factoryDenial)).toBe("update-docsfab-runtime");
    expect(inferRemediationId(factoryDenial)).not.toBe("verify-gitlab-project-access");
    expect(remediationText("update-docsfab-runtime")).toMatch(
      /retry publication of the saved run/u,
    );
    expect(remediationText("update-docsfab-runtime")).not.toMatch(
      /glab auth login|initialize again/iu,
    );
  });

  it("still maps an untyped GitLab-project message to project-access verification", () => {
    expect(
      inferRemediationId(new Error("Verify glab access to the selected GitLab project.")),
    ).toBe("verify-gitlab-project-access");
  });

  it("maps gitlab-unauthenticated to glab-auth-login by code", () => {
    const unauthenticated = Object.assign(
      new Error(
        "Local-user GitLab publication preflight failed (gitlab-unauthenticated). Authenticate glab for the selected GitLab host and retry.",
      ),
      { code: "gitlab-unauthenticated" },
    );
    expect(inferRemediationId(unauthenticated)).toBe("glab-auth-login");
    expect(remediationText("glab-auth-login")).toMatch(/glab auth login --hostname/u);
  });

  it("maps gitlab-unreachable to retry-gitlab-api by code", () => {
    const unreachable = Object.assign(
      new Error(
        "Local-user GitLab publication preflight failed (gitlab-unreachable). GitLab API for the selected remote host is unreachable.",
      ),
      { code: "gitlab-unreachable" },
    );
    expect(inferRemediationId(unreachable)).toBe("retry-gitlab-api");
    expect(remediationText("retry-gitlab-api")).not.toMatch(/glab auth login/iu);
  });

  it("maps tracked-source-dirty to a clean-working-tree NEXT, not a run-path mismatch", () => {
    const dirty = Object.assign(
      new Error(
        "Local-user GitLab publication preflight failed (tracked-source-dirty). Commit, stash, or discard tracked and staged changes, then retry. Untracked files are allowed.",
      ),
      { code: "tracked-source-dirty" },
    );
    expect(inferRemediationId(dirty)).toBe("clean-tracked-source");
    expect(remediationText("clean-tracked-source")).toMatch(/Untracked files are allowed/u);
    expect(remediationText("clean-tracked-source")).not.toMatch(/recorded by/u);
    expect(inferRemediationId(dirty)).not.toBe("retry-recorded-source-path");
  });

  it("maps ambiguous-remote to publish --remote rather than glab login", () => {
    const ambiguous = Object.assign(
      new Error(
        "Local-user GitLab publication preflight failed (ambiguous-remote). Keep one GitLab remote.",
      ),
      { code: "ambiguous-remote" },
    );
    expect(inferRemediationId(ambiguous)).toBe("select-publication-remote");
    expect(remediationText("select-publication-remote")).toMatch(/Pass --remote <name>/u);
    expect(remediationText("select-publication-remote")).toMatch(/selects origin/u);
    expect(remediationText("select-publication-remote")).not.toMatch(/glab auth login/iu);
  });

  it("keeps profile-seed routing for a missing MODEL profile", () => {
    const missing = Object.assign(new Error("MODEL profile is missing."), {
      code: "migration-required",
      reason: "no-profile",
    });
    expect(inferRemediationId(missing)).toBe("profile-seed");
  });
});
