// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RunRecord } from "./records/contracts.js";
import {
  exact,
  identifier,
  object,
  pattern,
  requireCondition,
  requireEqual,
  SHA256,
} from "./scorecard-record-parse.js";

export {
  decodeInference,
  decodeExecutionLeaseRuntimeEvidence,
} from "./scorecard-record-decode/inference-turn-lease.js";
export { decodeContextPreflight } from "./scorecard-record-decode/context-preflight.js";
export {
  decodeSecurityScan,
  decodeSecurityDisposition,
  decodeSecurityAuthorization,
  decodeSkillEvidence,
  decodeQualityPackEvidence,
} from "./scorecard-record-decode/security-skill.js";

/**
 * A participation record only restates what the step inherited, so it is
 * decoded against the evidence it claims to describe rather than trusted.
 * A record that names a different plan, digest or snapshot than the evidence
 * beside it is a forged provenance claim, not a harmless annotation.
 */
export function decodeSearchParticipation(
  value: unknown,
  evidence: NonNullable<RunRecord["steps"][number]["searchEvidence"]> | undefined,
  stepId: string,
  earlierStepIds: readonly string[],
): NonNullable<RunRecord["steps"][number]["searchParticipation"]> {
  const item = object(value);
  exact(item, [
    "schemaVersion",
    "kind",
    "planId",
    "searchMode",
    "observedByStepId",
    "searchEvidenceSha256",
    "workspaceSnapshotSha256",
  ]);
  requireEqual(item.schemaVersion, 1);
  requireEqual(item.kind, "docsfab-step-search-participation");
  requireCondition(evidence !== undefined);
  const searchMode = item.searchMode;
  requireCondition(
    searchMode === "observe" || searchMode === "revalidate" || searchMode === "reuse",
  );
  const planId = identifier(item.planId);
  const observedByStepId = identifier(item.observedByStepId);
  const searchEvidenceSha256 = pattern(item.searchEvidenceSha256, SHA256);
  const workspaceSnapshotSha256 = pattern(item.workspaceSnapshotSha256, SHA256);
  requireEqual(planId, evidence.planId);
  requireEqual(searchEvidenceSha256, evidence.evidenceSha256);
  requireEqual(workspaceSnapshotSha256, evidence.workspaceSnapshotSha256);
  // The observer must be the step itself when it did the observing, and some
  // OTHER step when it inherited. A record claiming to have reused its own
  // observation describes a step that cannot exist.
  if (searchMode === "observe" || searchMode === "revalidate") {
    requireEqual(observedByStepId, stepId);
  } else {
    // A reusing step inherits from a step that already ran. Naming itself, a
    // later step, or a step absent from this record describes an inheritance
    // that could not have happened.
    requireCondition(earlierStepIds.includes(observedByStepId));
  }
  return {
    schemaVersion: 1,
    kind: "docsfab-step-search-participation",
    planId,
    searchMode,
    observedByStepId,
    searchEvidenceSha256,
    workspaceSnapshotSha256,
  };
}
