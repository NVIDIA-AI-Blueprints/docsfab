// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ReaderContextComparisonV1,
  ReaderContextEvidenceReferenceV1,
  ReaderContextInputV1,
  ReaderContextPolicyIdentityV1,
  ReaderContextProvenanceSourceV1,
  ReaderContextProvenanceV1,
  ReaderContextV1,
} from "../context/reader-context.js";

import type { ResolvedResourceV1 } from "../records/contracts.js";

export type ReaderTaskContextInputOrigin = "explicit" | "conservative-fallback";
/**
 * No-change stays a candidate that must meet the baseline's evidence bar. The
 * input origin never decides eligibility, so no projection or handoff carries
 * any other value.
 */
export type ReaderTaskNoChangeAssessment = "requires-evidence";

export interface ReaderTaskContextBaselineV1 {
  /** The bound evaluation profile's reader-impact baseline, as the locked declaration names it. */
  path: string;
  sha256: string;
  content: string;
}

export interface ReaderTaskContextAdmissionV1 {
  admittedRevision: string;
  workspaceSnapshotSha256: string;
  repositoryIdentitySha256: string;
  comparison: ReaderContextComparisonV1;
  sources: readonly ReaderContextProvenanceSourceV1[];
  provenanceLimitations: readonly string[];
}

export interface ReaderTaskContextInputProjectionV1 {
  schemaVersion: 1;
  kind: "docsfab-reader-task-context-input";
  inputOrigin: ReaderTaskContextInputOrigin;
  noChangeAssessment: ReaderTaskNoChangeAssessment;
  readerContextInput: ReaderContextInputV1;
  baseline: ReaderTaskContextBaselineV1;
  policy: ReaderContextPolicyIdentityV1;
  /** Bounded product prompt assembled from verified bytes and validated input. */
  prompt: string;
}

export interface ReaderTaskContextProjectionV1
  extends Omit<ReaderTaskContextInputProjectionV1, "kind" | "prompt"> {
  kind: "docsfab-reader-task-context-completed";
  readerContext: ReaderContextV1;
  provenance: ReaderContextProvenanceV1;
  prompt: string;
}

export interface ReaderTaskContextHandoffV1 {
  schemaVersion: 1;
  kind: "docsfab-reader-task-context-handoff";
  inputOrigin: ReaderTaskContextInputOrigin;
  noChangeAssessment: ReaderTaskNoChangeAssessment;
  readerContextInput: ReaderContextInputV1;
  baselineSha256: string;
  policy: ReaderContextPolicyIdentityV1;
  admittedRevision: string;
  workspaceSnapshotSha256: string;
  repositoryIdentitySha256: string;
  comparison: ReaderContextComparisonV1;
  sources: ReaderContextProvenanceSourceV1[];
  provenanceLimitations: string[];
  /** Optional generic source artifact identity; it must resolve in `sources`. */
  sourceBinding: ReaderContextEvidenceReferenceV1 | null;
  handoffSha256: string;
}

/** The bound style profile as one step receives it, read from the verified pack. */
export interface StyleTaskContextV1 {
  schemaVersion: 1;
  kind: "docsfab-style-task-context";
  resource: ResolvedResourceV1;
  /** Delivered files in declared order; their bytes appear only in `prompt`. */
  files: ReadonlyArray<{ path: string; sha256: string }>;
  /** Bounded prompt text assembled from verified bytes. */
  prompt: string;
}
