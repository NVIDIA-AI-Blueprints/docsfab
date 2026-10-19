// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  SecurityScanAuthorizationEvidence,
  SecurityScanOverride,
  SecurityScanOverrideEvidence,
  SecurityScanOverrideRejectionRule,
  SecurityScanReport,
} from "./contracts.js";
import {
  detectCredentialRuleIds,
  SECURITY_SCAN_RULE_SET,
  SECURITY_RULE_IDS,
} from "./repository-scanner.js";

const MAX_REASON_LENGTH = 500;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

const OVERRIDABLE_RULES = new Set<string>([
  SECURITY_RULE_IDS.awsAccessKey,
  SECURITY_RULE_IDS.githubToken,
  SECURITY_RULE_IDS.gitlabToken,
  SECURITY_RULE_IDS.openAiApiKey,
  SECURITY_RULE_IDS.nvidiaApiKey,
  SECURITY_RULE_IDS.privateKey,
  SECURITY_RULE_IDS.jwt,
  SECURITY_RULE_IDS.assignedSecret,
]);

/**
 * Evaluates explicit grants over an already-completed scan. It never invokes or
 * configures the scanner, and completeness/scanner failures are never eligible.
 */
export function authorizeSecurityScan(
  report: SecurityScanReport,
  overrides: readonly SecurityScanOverride[],
  expectedRevision: string,
  now: Date,
): SecurityScanAuthorizationEvidence {
  const seenRules = new Set<string>();
  const evidence = overrides.map((override) => {
    const findingCount = report.findings.filter(
      (finding) => finding.ruleId === override.ruleId,
    ).length;
    const rejectionRuleId = rejectionRule(
      report,
      override,
      expectedRevision,
      now,
      seenRules,
      findingCount,
    );
    seenRules.add(override.ruleId);
    return overrideEvidence(override, expectedRevision, findingCount, rejectionRuleId);
  });

  const coveredRules = new Set(
    evidence
      .filter((override) => override.decision === "authorized")
      .map((override) => override.ruleId),
  );
  const everyFindingCovered =
    report.findings.length > 0 &&
    report.findings.every(
      (finding) => OVERRIDABLE_RULES.has(finding.ruleId) && coveredRules.has(finding.ruleId),
    );

  return {
    status:
      report.status === "blocked" &&
      evidence.length > 0 &&
      evidence.every((override) => override.decision === "authorized") &&
      everyFindingCovered
        ? "authorized"
        : "denied",
    overrides: evidence,
  };
}

function rejectionRule(
  report: SecurityScanReport,
  override: SecurityScanOverride,
  expectedRevision: string,
  now: Date,
  seenRules: ReadonlySet<string>,
  findingCount: number,
): SecurityScanOverrideRejectionRule | undefined {
  if (report.ruleSet !== SECURITY_SCAN_RULE_SET) return "override.scan-failed";
  if (report.status === "failed") return "override.scan-failed";
  if (report.status !== "blocked") return "override.scan-not-blocked";
  if (!OVERRIDABLE_RULES.has(override.ruleId)) {
    return "override.ineligible-rule";
  }
  if (override.revision !== expectedRevision) {
    return "override.revision-mismatch";
  }
  if (!override.reason.trim()) return "override.reason-required";
  if (
    override.reason.length > MAX_REASON_LENGTH ||
    CONTROL_CHARACTER.test(override.reason) ||
    detectCredentialRuleIds(override.reason).length > 0
  ) {
    return "override.reason-invalid";
  }
  const expiry = parseExpiry(override.expiresAt);
  if (!expiry) return "override.expiry-invalid";
  if (expiry.getTime() <= now.getTime()) return "override.expired";
  if (seenRules.has(override.ruleId)) return "override.duplicate-rule";
  if (findingCount === 0) return "override.no-matching-finding";
  return undefined;
}

const ISO_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/u;

function parseExpiry(value: string): Date | undefined {
  const match = ISO_DATE_TIME.exec(value);
  if (!match) return undefined;
  const [, yearRaw, monthRaw, dayRaw, hourRaw, minuteRaw, secondRaw, , zone] = match;
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const second = Number(secondRaw);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return undefined;
  }
  if (!zone) return undefined;
  if (zone !== "Z") {
    const [offsetHour, offsetMinute] = zone.slice(1).split(":").map(Number);
    if (
      offsetHour === undefined ||
      offsetMinute === undefined ||
      offsetHour > 23 ||
      offsetMinute > 59
    ) {
      return undefined;
    }
  }
  const expiry = new Date(value);
  if (Number.isNaN(expiry.getTime())) return undefined;
  return expiry;
}

function overrideEvidence(
  override: SecurityScanOverride,
  expectedRevision: string,
  findingCount: number,
  rejectionRuleId: SecurityScanOverrideRejectionRule | undefined,
): SecurityScanOverrideEvidence {
  return {
    ruleId: safeRuleId(override.ruleId),
    revision: safeRevision(override.revision, expectedRevision),
    reason: safeReason(override.reason),
    expiresAt: safeExpiry(override.expiresAt),
    decision: rejectionRuleId ? "rejected" : "authorized",
    findingCount,
    ...(rejectionRuleId ? { rejectionRuleId } : {}),
  };
}

function safeRuleId(ruleId: string): string {
  if (ruleId.length <= 100 && /^(?:credential|policy|scanner)\.[a-z0-9.-]+$/u.test(ruleId)) {
    return ruleId;
  }
  return "[invalid rule omitted]";
}

function safeRevision(revision: string, expectedRevision: string): string {
  if (revision === expectedRevision || /^[a-f0-9]{40,64}$/u.test(revision)) {
    return revision;
  }
  return "[invalid revision omitted]";
}

function safeExpiry(expiresAt: string): string {
  return parseExpiry(expiresAt)?.toISOString() ?? "[invalid expiry omitted]";
}

function safeReason(reason: string): string {
  if (
    reason.length > MAX_REASON_LENGTH ||
    CONTROL_CHARACTER.test(reason) ||
    detectCredentialRuleIds(reason).length > 0
  ) {
    return "[invalid reason omitted]";
  }
  return reason.trim();
}
