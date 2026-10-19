// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { validateStagedQualityArtifact } from "../src/evaluation-report/quality-schema-validation.js";

const ISSUE = {
  id: "TECH-001",
  severity: "major",
  category: "technical_accuracy",
  location: "docs/install.md#requirements",
  finding: "The documented minimum version conflicts with the release notes.",
  evidence: { source_id: "release-notes", locator: "Requirements" },
  required_change: "State the minimum version from the release notes.",
};

describe("staged quality schema loading", () => {
  it("validates review results against a schema that carries enum descriptions", () => {
    const staged = JSON.parse(
      readFileSync(
        new URL("../quality/schemas/review-result.schema.json", import.meta.url),
        "utf8",
      ),
    );
    const issueProperties = staged.properties.issues.items.properties;
    expect(issueProperties.category).toHaveProperty("x-docsfab-enum-descriptions");
    expect(issueProperties.severity).toHaveProperty("x-docsfab-enum-descriptions");

    expect(
      validateStagedQualityArtifact("review-result.schema.json", {
        verdict: "needs-revision",
        issues: [ISSUE],
      }),
    ).toBe("valid");
    expect(
      validateStagedQualityArtifact("review-result.schema.json", {
        verdict: "needs-revision",
        issues: [{ ...ISSUE, category: "accessibility" }],
      }),
    ).toBe("invalid");
  });
});
