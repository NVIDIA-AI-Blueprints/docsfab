// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { SecurityScanOverride, SecurityScanReport } from "../src/security/contracts.js";
import { SECURITY_RULE_IDS } from "../src/security/repository-scanner.js";
import { authorizeSecurityScan } from "../src/security/scan-override.js";

const revision = "a".repeat(40);
const now = new Date("2026-08-03T12:00:00.000Z");

function blockedReport(
  findings: SecurityScanReport["findings"] = [
    { path: "docs/example.md", ruleId: SECURITY_RULE_IDS.assignedSecret },
  ],
): SecurityScanReport {
  return {
    ruleSet: "docsfab-local-v2",
    status: "blocked",
    scannedFiles: 1,
    binaryFiles: 0,
    findings,
  };
}

function override(values: Partial<SecurityScanOverride> = {}): SecurityScanOverride {
  return {
    ruleId: SECURITY_RULE_IDS.assignedSecret,
    revision,
    reason: "Reviewed documentation fixture false positive",
    expiresAt: "2026-08-10T12:00:00.000Z",
    ...values,
  };
}

describe("authorizeSecurityScan", () => {
  it("authorizes every finding for an exact revision and credential rule", () => {
    const result = authorizeSecurityScan(
      blockedReport([
        { path: "a.md", ruleId: SECURITY_RULE_IDS.assignedSecret },
        { path: "b.md", ruleId: SECURITY_RULE_IDS.assignedSecret },
      ]),
      [override()],
      revision,
      now,
    );

    expect(result).toEqual({
      status: "authorized",
      overrides: [
        {
          ...override(),
          decision: "authorized",
          findingCount: 2,
        },
      ],
    });
  });

  it.each([
    ["2026-08-10T12:00:00Z", "2026-08-10T12:00:00.000Z"],
    ["2026-08-10T12:00:00.123Z", "2026-08-10T12:00:00.123Z"],
    ["2026-08-10T12:00:00.123456Z", "2026-08-10T12:00:00.123Z"],
    ["2026-08-10T08:00:00-04:00", "2026-08-10T12:00:00.000Z"],
  ])("accepts and canonicalizes ISO expiry %s", (expiresAt, canonical) => {
    const result = authorizeSecurityScan(blockedReport(), [override({ expiresAt })], revision, now);

    expect(result.status).toBe("authorized");
    expect(result.overrides[0]?.expiresAt).toBe(canonical);
  });

  it.each(["2026-02-30T12:00:00Z", "2026-08-10", "2026-08-10 12:00:00"])(
    "rejects non-canonical or impossible expiry %s",
    (expiresAt) => {
      const result = authorizeSecurityScan(
        blockedReport(),
        [override({ expiresAt })],
        revision,
        now,
      );
      expect(result.overrides[0]?.rejectionRuleId).toBe("override.expiry-invalid");
    },
  );

  it.each([
    ["revision mismatch", override({ revision: "b".repeat(40) }), "override.revision-mismatch"],
    ["missing reason", override({ reason: "   " }), "override.reason-required"],
    ["invalid expiry", override({ expiresAt: "next Tuesday" }), "override.expiry-invalid"],
    ["expired grant", override({ expiresAt: "2026-08-03T12:00:00.000Z" }), "override.expired"],
    [
      "unused rule",
      override({ ruleId: SECURITY_RULE_IDS.githubToken }),
      "override.no-matching-finding",
    ],
  ])("denies a %s", (_label, request, rejectionRuleId) => {
    const result = authorizeSecurityScan(blockedReport(), [request], revision, now);

    expect(result.status).toBe("denied");
    expect(result.overrides[0]).toMatchObject({
      decision: "rejected",
      rejectionRuleId,
    });
  });

  it("never authorizes scanner or completeness-policy findings", () => {
    for (const [status, ruleId] of [
      ["failed", SECURITY_RULE_IDS.scannerFailure],
      ["blocked", SECURITY_RULE_IDS.fileTooLarge],
      ["blocked", SECURITY_RULE_IDS.symbolicLink],
      ["blocked", SECURITY_RULE_IDS.metadataApiToken],
      ["blocked", SECURITY_RULE_IDS.metadataAssignedSecret],
    ] as const) {
      const result = authorizeSecurityScan(
        { ...blockedReport([{ path: "artifact", ruleId }]), status },
        [override({ ruleId })],
        revision,
        now,
      );

      expect(result.status).toBe("denied");
      expect(result.overrides[0]?.decision).toBe("rejected");
      expect(result.overrides[0]?.rejectionRuleId).toBe(
        status === "failed" ? "override.scan-failed" : "override.ineligible-rule",
      );
    }
  });

  it("rejects overrides issued for a prior scanner rule set", () => {
    const result = authorizeSecurityScan(
      { ...blockedReport(), ruleSet: "docsfab-local-v1" },
      [override()],
      revision,
      now,
    );
    expect(result.status).toBe("denied");
    expect(result.overrides[0]?.rejectionRuleId).toBe("override.scan-failed");
  });

  it("denies partial coverage and duplicate grants", () => {
    const findings = [
      { path: "generic.md", ruleId: SECURITY_RULE_IDS.assignedSecret },
      { path: "token.md", ruleId: SECURITY_RULE_IDS.gitlabToken },
    ];
    const partial = authorizeSecurityScan(blockedReport(findings), [override()], revision, now);
    const duplicate = authorizeSecurityScan(
      blockedReport(),
      [override(), override()],
      revision,
      now,
    );

    expect(partial.status).toBe("denied");
    expect(duplicate.status).toBe("denied");
    expect(duplicate.overrides[1]?.rejectionRuleId).toBe("override.duplicate-rule");
  });

  it("rejects grants when the scan itself passed", () => {
    const result = authorizeSecurityScan(
      { ...blockedReport([]), status: "passed" },
      [override()],
      revision,
      now,
    );

    expect(result).toMatchObject({
      status: "denied",
      overrides: [
        {
          decision: "rejected",
          rejectionRuleId: "override.scan-not-blocked",
        },
      ],
    });
  });

  it("omits an invalid free-text reason from evidence", () => {
    const result = authorizeSecurityScan(
      blockedReport(),
      [override({ reason: "line one\nline two" })],
      revision,
      now,
    );

    expect(result.overrides[0]).toMatchObject({
      decision: "rejected",
      reason: "[invalid reason omitted]",
      rejectionRuleId: "override.reason-invalid",
    });
  });

  it("rejects and omits credential material pasted into the reason", () => {
    // A mask such as xxxx is a documentation placeholder, so use a real-looking value.
    const secret = `password=${["Zq8Zr2Lm", "X9vTp4Ks", "W1eY"].join("")}`;
    const result = authorizeSecurityScan(
      blockedReport(),
      [override({ reason: `Reviewed token ${secret}` })],
      revision,
      now,
    );

    expect(result.overrides[0]).toMatchObject({
      decision: "rejected",
      reason: "[invalid reason omitted]",
      rejectionRuleId: "override.reason-invalid",
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});
