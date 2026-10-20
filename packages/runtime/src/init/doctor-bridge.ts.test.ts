// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { remediationIdForDoctorDiagnostic } from "../operator/remediation.js";
import { nextActions } from "./doctor-bridge.js";

describe("init doctor bridge versus doctor missing-key NEXT", () => {
  it("keeps init next-actions on the shared profile-inspect id", () => {
    expect(nextActions("configured", "ready", "profile-diagnostics-required")).toEqual([
      "profile-inspect",
    ]);
    expect(nextActions("missing", "unavailable", "profile-diagnostics-required")).toEqual([
      "glab-auth-login",
      "profile-inspect",
    ]);
  });

  it("does not fold setup into init; doctor missing-key mapping stays on profile-setup", () => {
    expect(remediationIdForDoctorDiagnostic("provider-credentials-missing")).toBe("profile-setup");
    expect(remediationIdForDoctorDiagnostic("metadata-api-key-missing")).toBeUndefined();
    expect(nextActions("configured", "ready", "diagnostics-required")).toEqual(["doctor"]);
    expect(nextActions("configured", "ready", "ready")).toEqual([]);
    expect(nextActions("unreachable", "unavailable", "ready")).toEqual(["retry-gitlab-api"]);
    expect(nextActions("unreachable", "unavailable", "ready")).not.toContain("glab-auth-login");
  });
});
