// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

vi.mock("../src/config/private-content-paths.js", () => ({
  PRIVATE_CONTENT_PATHS: Object.freeze({}),
}));

import { internalContentPath } from "../src/config/internal-content.js";

describe("public optional content boundary", () => {
  it.each([
    "modelComparisonSource",
    "modelComparisonInstalled",
    "nativePilotSource",
    "harnessRoleQualificationSource",
    "sourceCoverageTools",
    "documentationSupervision",
  ] as const)("refuses %s explicitly without substituting a corpus", (id) => {
    expect(() => internalContentPath(id)).toThrow("internal-content-unavailable");
    try {
      internalContentPath(id);
    } catch (error) {
      expect(error).toMatchObject({ code: "internal-content-unavailable" });
      expect(String(error)).toContain("authorized internal checkout");
    }
  });
});
