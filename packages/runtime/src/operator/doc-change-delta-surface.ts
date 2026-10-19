// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Project DocChangeDelta beside patch digests for CLI JSON, for display and
 * review only. Missing evidence yields an explicit unavailable limitation,
 * never invented prose.
 */

import type { RunRecord } from "../records/contracts.js";
import { canonicalDigest } from "../content-ir/canonical.js";
import {
  DocChangeDeltaProjectorError,
  projectDocChangeDeltaFromGapLedger,
  type DocChangeDeltaDisplayLifecycle,
  type DocChangeDeltaSection,
  type DocChangeDeltaV1,
} from "../search/index.js";

export type DocChangeDeltaSurfaceLimitationV1 =
  | "gap-ledger-unavailable"
  | "repository-content-digest-unavailable"
  | "revision-mismatch"
  | "projection-failed"
  | "not-applicable";

export interface DocChangeDeltaSurfaceEntryV1 {
  section: DocChangeDeltaSection;
  stableId: string;
  codes: readonly string[];
  labels: readonly string[];
  displayLifecycle: DocChangeDeltaDisplayLifecycle | null;
}

export interface DocChangeDeltaSurfaceSummaryV1 {
  added: number;
  modified: number;
  removed: number;
  entries: readonly DocChangeDeltaSurfaceEntryV1[];
}

export type DocChangeDeltaCliSurfaceV1 =
  | {
      status: "projected";
      kind: "docsfab-doc-change-delta";
      deltaSha256: string;
      sourceRunRecordSha256: string;
      sourceLedgerSha256: string | null;
      repositoryRevision: string;
      repositoryIdentitySha256: string;
      trackerMutation: "not-authorized";
      summary: DocChangeDeltaSurfaceSummaryV1;
    }
  | {
      status: "unavailable";
      limitation: DocChangeDeltaSurfaceLimitationV1;
    };

export interface ProjectDocChangeDeltaCliSurfaceInput {
  record: RunRecord;
  /** Pre-write repository content digest for the immutable run revision. */
  repositoryContentDigestSha256?: string;
}

/**
 * A content-free DocChangeDelta surface or an explicit unavailable limitation;
 * `null` when there is no patch.
 */
export function projectDocChangeDeltaCliSurface(
  input: ProjectDocChangeDeltaCliSurfaceInput,
): DocChangeDeltaCliSurfaceV1 | null {
  const patch = input.record.changes?.patch;
  if (!patch) return null;

  const ledger = input.record.gapLedger;
  if (!ledger) {
    return { status: "unavailable", limitation: "gap-ledger-unavailable" };
  }

  if (ledger.currentRevision !== input.record.repository.revision) {
    return { status: "unavailable", limitation: "revision-mismatch" };
  }

  const repositoryContentDigestSha256 = resolveRepositoryContentDigest(
    input.record,
    input.repositoryContentDigestSha256,
  );
  if (!repositoryContentDigestSha256) {
    return {
      status: "unavailable",
      limitation: "repository-content-digest-unavailable",
    };
  }

  const sourceRunRecordSha256 = canonicalDigest(input.record);
  try {
    const delta = projectDocChangeDeltaFromGapLedger({
      ledger,
      runBindings: {
        sourceRunRecordSha256,
        repositoryIdentitySha256: ledger.repositoryIdentitySha256,
        repositoryRevision: input.record.repository.revision,
        repositoryContentDigestSha256,
        expectedLedgerSha256: ledger.ledgerSha256,
      },
    });
    return projectedSurface(delta);
  } catch (error) {
    if (error instanceof DocChangeDeltaProjectorError) {
      return { status: "unavailable", limitation: "projection-failed" };
    }
    throw error;
  }
}

/** Human-readable ADDED / MODIFIED / REMOVED lines for non-authoritative review. */
export function formatDocChangeDeltaReviewLines(
  surface: DocChangeDeltaCliSurfaceV1 | null,
): string[] {
  if (!surface) return [];
  if (surface.status === "unavailable") {
    return [`DocChangeDelta: unavailable (${surface.limitation})`];
  }
  const lines = [
    `DocChangeDelta: ${surface.deltaSha256}`,
    `  ADDED: ${surface.summary.added}` +
      `  MODIFIED: ${surface.summary.modified}` +
      `  REMOVED: ${surface.summary.removed}`,
  ];
  for (const entry of surface.summary.entries) {
    const label = entry.section.toUpperCase();
    const codes = entry.codes.length > 0 ? ` [${entry.codes.join(", ")}]` : "";
    lines.push(`  ${label} ${entry.stableId}${codes}`);
  }
  return lines;
}

function projectedSurface(delta: DocChangeDeltaV1): DocChangeDeltaCliSurfaceV1 {
  const entries: DocChangeDeltaSurfaceEntryV1[] = delta.entries.map((entry) => ({
    section: entry.section,
    stableId: entry.stableId,
    codes: [...entry.codes],
    labels: [...entry.labels],
    displayLifecycle: entry.displayLifecycle,
  }));
  return {
    status: "projected",
    kind: "docsfab-doc-change-delta",
    deltaSha256: delta.deltaSha256,
    sourceRunRecordSha256: delta.sourceRunRecordSha256,
    sourceLedgerSha256: delta.sourceLedgerSha256,
    repositoryRevision: delta.repositoryRevision,
    repositoryIdentitySha256: delta.repositoryIdentitySha256,
    trackerMutation: "not-authorized",
    summary: {
      added: entries.filter((entry) => entry.section === "added").length,
      modified: entries.filter((entry) => entry.section === "modified").length,
      removed: entries.filter((entry) => entry.section === "removed").length,
      entries,
    },
  };
}

function resolveRepositoryContentDigest(record: RunRecord, explicit?: string): string | undefined {
  if (explicit && SHA256.test(explicit)) return explicit;
  const digests = new Set<string>();
  for (const use of record.artifacts ?? []) {
    if (use.reference.repositoryRevision !== record.repository.revision) continue;
    if (!SHA256.test(use.reference.repositoryContentDigest)) continue;
    digests.add(use.reference.repositoryContentDigest);
  }
  if (digests.size === 1) return [...digests][0];
  return undefined;
}

const SHA256 = /^[a-f0-9]{64}$/u;
