// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RunRecord } from "../records/contracts.js";

export interface SecurityScanCliMessage {
  stream: "stdout" | "stderr";
  text: string;
}

export interface SecurityScanCliOptions {
  showScan?: boolean;
}

type ScanRecord = Pick<
  RunRecord,
  "securityScan" | "securityScanEffectiveDisposition" | "securityScanAuthorization"
>;

export function formatSecurityScanCliMessages(
  record: ScanRecord,
  options: SecurityScanCliOptions = {},
): SecurityScanCliMessage[] {
  if (!record.securityScan) return [];
  const raw = record.securityScan;
  const effective = record.securityScanEffectiveDisposition?.status ?? raw.status;
  const allowed = effective === "advisory" || effective === "passed" || effective === "authorized";
  const stream = allowed ? "stdout" : "stderr";
  const messages: SecurityScanCliMessage[] = [
    {
      stream,
      text: `Repository scan: ${raw.findings.length} finding(s); effective ${effective}.`,
    },
  ];

  if (options.showScan) {
    const ruleIds = [...new Set(raw.findings.map((finding) => finding.ruleId))].sort();
    for (const ruleId of ruleIds) {
      messages.push({
        stream: allowed ? "stdout" : "stderr",
        text: `Repository scan rule: ${ruleId}.`,
      });
    }
  }

  for (const override of record.securityScanAuthorization?.overrides ?? []) {
    const rejected = override.decision === "rejected";
    messages.push({
      stream: rejected || !allowed ? "stderr" : "stdout",
      text: [
        `Scanner authorization grant ${override.decision}:`,
        `${override.ruleId} at ${override.revision}`,
        `(expires ${override.expiresAt})`,
        ...(override.rejectionRuleId ? [`[${override.rejectionRuleId}]`] : []),
      ].join(" "),
    });
  }
  return messages;
}
