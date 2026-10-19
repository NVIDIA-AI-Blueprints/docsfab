// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";

export interface QualityReportSummaryFixture {
  readonly name: string;
  readonly valid: boolean;
  readonly summary: Record<string, unknown>;
}

const fixturePath = new URL(
  "../../../quality/tests/fixtures/quality-report/quality-report-matrix.json",
  import.meta.url,
);

export function loadQualityReportSummaryFixtures(): readonly QualityReportSummaryFixture[] {
  const value = JSON.parse(readFileSync(fixturePath, "utf8")) as unknown;
  if (!Array.isArray(value)) throw new Error("Quality report fixture matrix must be an array.");
  return Object.freeze(
    value.map((fixture) => {
      if (
        fixture === null ||
        typeof fixture !== "object" ||
        Array.isArray(fixture) ||
        typeof fixture.name !== "string" ||
        typeof fixture.valid !== "boolean" ||
        fixture.summary === null ||
        typeof fixture.summary !== "object" ||
        Array.isArray(fixture.summary)
      ) {
        throw new Error("Quality report fixture matrix contains an invalid entry.");
      }
      return Object.freeze({
        name: fixture.name,
        valid: fixture.valid,
        summary: fixture.summary as Record<string, unknown>,
      });
    }),
  );
}

export function qualityReportMarkdown(summary: Record<string, unknown>): string {
  const limitations =
    summary.report_contract === "docsfab-quality-report-v0.2" && Array.isArray(summary.limitations)
      ? summary.limitations.map((item) => `- Limitation: ${String(item)}`)
      : ["- Limitation: Shared fixture report."];
  return [
    "# Documentation quality evaluation report",
    "",
    "## Validated result summary",
    "",
    "```json",
    JSON.stringify(summary),
    "```",
    "",
    "## Evidence gaps and limitations",
    "",
    ...limitations,
  ].join("\n");
}
