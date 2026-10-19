// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type SecurityScanStatus = "passed" | "blocked" | "failed";
export interface SecurityScanFinding {
  path: string;
  ruleId: string;
}
export interface SecurityScanReport {
  ruleSet: string;
  status: SecurityScanStatus;
  scannedFiles: number;
  binaryFiles: number;
  findings: SecurityScanFinding[];
}
export type SecurityScanEffectiveStatus =
  | "advisory"
  | "passed"
  | "blocked"
  | "failed"
  | "authorized"
  | "denied";
export interface SecurityScanEffectiveDisposition {
  status: SecurityScanEffectiveStatus;
}
export interface SecurityScanOverride {
  ruleId: string;
  revision: string;
  reason: string;
  expiresAt: string;
}
export type SecurityScanOverrideRejectionRule =
  | "override.scan-not-blocked"
  | "override.scan-failed"
  | "override.ineligible-rule"
  | "override.revision-mismatch"
  | "override.reason-required"
  | "override.reason-invalid"
  | "override.expiry-invalid"
  | "override.expired"
  | "override.duplicate-rule"
  | "override.no-matching-finding";
export interface SecurityScanOverrideEvidence extends SecurityScanOverride {
  decision: "authorized" | "rejected";
  findingCount: number;
  rejectionRuleId?: SecurityScanOverrideRejectionRule;
}
export interface SecurityScanAuthorizationEvidence {
  status: "authorized" | "denied";
  overrides: SecurityScanOverrideEvidence[];
}
export interface RepositorySecurityScanner {
  scan(repositoryPath: string): Promise<SecurityScanReport>;
}
