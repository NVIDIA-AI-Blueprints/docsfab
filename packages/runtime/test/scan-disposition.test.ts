// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type {
  SecurityScanAuthorizationEvidence,
  SecurityScanReport,
} from "../src/security/contracts.js";
import { formatSecurityScanCliMessages } from "../src/security/scan-cli.js";
import { resolveSecurityScanEffectiveDisposition } from "../src/security/scan-disposition.js";

const report: SecurityScanReport = {
  ruleSet: "docsfab-local-v2",
  status: "blocked",
  scannedFiles: 2,
  binaryFiles: 0,
  findings: [{ path: "docs/example.md", ruleId: "credential.assigned-secret" }],
};

const authorized: SecurityScanAuthorizationEvidence = {
  status: "authorized",
  overrides: [
    {
      ruleId: "credential.assigned-secret",
      revision: "a".repeat(40),
      reason: "Reviewed fixture",
      expiresAt: "2026-08-10T12:00:00.000Z",
      decision: "authorized",
      findingCount: 1,
    },
  ],
};

const denied: SecurityScanAuthorizationEvidence = { status: "denied", overrides: [] };

describe("resolveSecurityScanEffectiveDisposition", () => {
  it.each([
    ["passed", undefined, "passed"],
    ["blocked", undefined, "passed"],
    ["failed", undefined, "failed"],
    ["blocked", authorized, "authorized"],
    ["blocked", denied, "denied"],
  ] as const)("resolves %s with %s", (status, authorization, effective) => {
    expect(resolveSecurityScanEffectiveDisposition({ ...report, status }, authorization)).toEqual({
      status: effective,
    });
  });

  it("does not mutate raw scanner evidence", () => {
    const before = structuredClone(report);
    resolveSecurityScanEffectiveDisposition(report, authorized);
    expect(report).toEqual(before);
  });
});

describe("formatSecurityScanCliMessages", () => {
  it("collapses findings by default", () => {
    const messages = formatSecurityScanCliMessages({
      securityScan: report,
      securityScanEffectiveDisposition: { status: "authorized" },
      securityScanAuthorization: authorized,
    });
    const text = messages.map((message) => message.text).join("\n");

    expect(text).toContain("Repository scan: 1 finding(s); effective authorized.");
    expect(text).not.toContain("docs/example.md");
    expect(text).not.toContain("Repository scan finding:");
    expect(messages.every((message) => message.stream === "stdout")).toBe(true);
  });

  it("lists rule IDs when showScan is enabled", () => {
    const messages = formatSecurityScanCliMessages(
      {
        securityScan: report,
        securityScanEffectiveDisposition: { status: "authorized" },
        securityScanAuthorization: authorized,
      },
      { showScan: true },
    );
    const text = messages.map((message) => message.text).join("\n");

    expect(text).toContain("Repository scan rule: credential.assigned-secret.");
    expect(text).not.toContain("docs/example.md");
    expect(text).not.toContain("Reviewed fixture");
    expect(messages.every((message) => message.stream === "stdout")).toBe(true);
  });

  it("prints denied findings on stderr without file paths by default", () => {
    const messages = formatSecurityScanCliMessages({
      securityScan: report,
      securityScanEffectiveDisposition: { status: "denied" },
      securityScanAuthorization: {
        status: "denied",
        overrides: [
          {
            ...authorized.overrides[0]!,
            decision: "rejected",
            rejectionRuleId: "override.expired",
          },
        ],
      },
    });
    const text = messages.map((message) => message.text).join("\n");

    expect(text).toContain("Repository scan: 1 finding(s); effective denied.");
    expect(text).not.toContain("docs/example.md");
    expect(text).toContain("[override.expired]");
    expect(text).not.toContain("Reviewed fixture");
    expect(messages.every((message) => message.stream === "stderr")).toBe(true);
  });

  it("reports accepted grants as non-global evidence when coverage is partial", () => {
    const messages = formatSecurityScanCliMessages(
      {
        securityScan: {
          ...report,
          findings: [
            ...report.findings,
            { path: "docs/token.md", ruleId: "credential.gitlab-token" },
          ],
        },
        securityScanEffectiveDisposition: { status: "denied" },
        securityScanAuthorization: {
          status: "denied",
          overrides: authorized.overrides,
        },
      },
      { showScan: true },
    );
    const text = messages.map((message) => message.text).join("\n");

    expect(text).toContain("Repository scan: 2 finding(s); effective denied.");
    expect(text).toContain("Repository scan rule: credential.assigned-secret.");
    expect(text).toContain("Repository scan rule: credential.gitlab-token.");
    expect(text).toContain("Scanner authorization grant authorized:");
    expect(text).not.toContain("Scanner authorization authorized:");
    expect(messages.every((message) => message.stream === "stderr")).toBe(true);
  });
});
