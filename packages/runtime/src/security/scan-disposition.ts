// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  SecurityScanAuthorizationEvidence,
  SecurityScanEffectiveDisposition,
  SecurityScanReport,
} from "./contracts.js";

/** Resolve policy without mutating the immutable raw scanner report. */
export function resolveSecurityScanEffectiveDisposition(
  report: SecurityScanReport,
  authorization?: SecurityScanAuthorizationEvidence,
): SecurityScanEffectiveDisposition {
  if (report.status === "failed") return { status: "failed" };
  if (authorization?.status === "authorized") {
    return { status: "authorized" };
  }
  if (authorization?.status === "denied") return { status: "denied" };
  // Credential-shaped repository content (a blocked report) is diagnostic
  // input. A scanner failure stays fatal, and an explicit authorization keeps
  // its authorized or denied outcome.
  return { status: "passed" };
}
