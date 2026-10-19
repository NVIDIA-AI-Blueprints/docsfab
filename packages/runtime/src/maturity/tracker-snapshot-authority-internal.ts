// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { canonicalDigest } from "../content-ir/canonical.js";
import type { RoadmapProjectIdentity } from "../roadmap/contracts/ledger.js";
import type { SanitizedRoadmapIssue } from "../roadmap/planning.js";

/** @internal Host-only authority for one exact, already authenticated tracker snapshot. */
export interface InternalDocumentationMaturityTrackerSnapshot {
  readonly kind: "docsfab-internal-documentation-maturity-tracker-snapshot";
}

interface SnapshotState {
  project: RoadmapProjectIdentity;
  issues: readonly SanitizedRoadmapIssue[];
  observedAtEpochMs: number;
  observedAtMonotonicMs: number;
  digest: string;
}

const snapshots = new WeakMap<object, SnapshotState>();

export function internalIssueDocumentationMaturityTrackerSnapshot(input: {
  project: RoadmapProjectIdentity;
  issues: readonly SanitizedRoadmapIssue[];
  observedAtEpochMs: number;
  observedAtMonotonicMs: number;
}): InternalDocumentationMaturityTrackerSnapshot {
  const digest = canonicalDigest({
    project: input.project,
    issues: input.issues,
    observedAtEpochMs: input.observedAtEpochMs,
    observedAtMonotonicMs: input.observedAtMonotonicMs,
  });
  const capability = Object.freeze({
    kind: "docsfab-internal-documentation-maturity-tracker-snapshot" as const,
  });
  snapshots.set(capability, {
    project: input.project,
    issues: input.issues,
    observedAtEpochMs: input.observedAtEpochMs,
    observedAtMonotonicMs: input.observedAtMonotonicMs,
    digest,
  });
  return capability;
}

export function internalDocumentationMaturityTrackerSnapshotState(
  capability: InternalDocumentationMaturityTrackerSnapshot,
): SnapshotState | undefined {
  return capability && typeof capability === "object" ? snapshots.get(capability) : undefined;
}
