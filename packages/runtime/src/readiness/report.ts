// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Read-only presentation of a retained, canonically verified readiness outcome. */
import type { RunRecord } from "../records/contracts.js";
import { workflowOutcomeState } from "../workflow-contracts/outcome.js";

export function readinessOutcomeLines(record: RunRecord): readonly string[] {
  if (record.workflow !== "readiness" && record.workflow !== "release-documentation-readiness")
    return [];
  const state = workflowOutcomeState(record);
  if (state.state !== "current")
    return ["Readiness: unavailable. Execution success does not establish readiness."];
  return [
    `Readiness: ${state.outcome.disposition}.`,
    ...state.outcome.findings.map((finding) => `Readiness finding: ${finding.code}.`),
    ...state.outcome.limitations.map((limitation) => `Readiness limitation: ${limitation}.`),
    "This assessment grants no release or publication approval.",
  ];
}
