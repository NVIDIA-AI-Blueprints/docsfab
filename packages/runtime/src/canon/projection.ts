// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createContractKit, type ContractFail } from "../contract-kit/index.js";
import {
  FoundationCanonContractError,
  decodeFoundationCanon,
  projectFoundationCanon,
  type FoundationCanonProjectionV1,
  type FoundationCanonState,
  type FoundationCanonV1,
} from "./contracts.js";
import type { FoundationCanonStoredArtifactV1 } from "./persistence.js";

export type FoundationCanonProjectionErrorCode =
  | "invalid-shape"
  | "invalid-value"
  | "digest-mismatch"
  | "credential-material"
  | "migration-required";

export class FoundationCanonProjectionError extends Error {
  public constructor(public readonly code: FoundationCanonProjectionErrorCode) {
    super(`Foundation canon projection rejected: ${code}.`);
    this.name = "FoundationCanonProjectionError";
  }
}

function fail(code: FoundationCanonProjectionErrorCode): never {
  throw new FoundationCanonProjectionError(code);
}

const kit = createContractKit({
  fail: fail as ContractFail<FoundationCanonProjectionErrorCode>,
  codes: {
    invalidShape: "invalid-shape",
    invalidValue: "invalid-value",
    digestMismatch: "digest-mismatch",
    credentialMaterial: "credential-material",
    schemaMismatch: "migration-required",
  },
});

/** Concise, credential-free human report projection (not Markdown authority). */
export interface FoundationCanonReportV1 {
  schemaVersion: 1;
  kind: "docsfab-foundation-canon-report";
  canonId: string;
  version: string;
  state: FoundationCanonState;
  repositoryRevision: string;
  claimCount: number;
  conflictCount: number;
  gapCount: number;
  affectedDocumentCount: number;
  hasAuthority: boolean;
  supersedes: boolean;
  canonSha256: string;
  machineProjectionSha256: string;
  reportSha256: string;
}

/**
 * Project machine JSON (existing sealed projection) and a concise human report
 * that round-trips to the same canon identity without granting authority.
 */
export function projectFoundationCanonSurfaces(value: unknown): {
  machine: FoundationCanonProjectionV1;
  report: FoundationCanonReportV1;
} {
  const canon = decodeOrFail(value);
  const machine = projectFoundationCanon(canon);
  const gaps = countGaps(canon);
  const report = kit.seal("docsfab-foundation-canon-report", "reportSha256", {
    canonId: canon.canonId,
    version: canon.version,
    state: canon.state,
    repositoryRevision: canon.repository.revision,
    claimCount: canon.claims.length,
    conflictCount: canon.conflicts.length,
    gapCount: gaps,
    affectedDocumentCount: canon.affectedArtifacts.length,
    hasAuthority: canon.authority !== null,
    supersedes: canon.supersession !== null,
    canonSha256: canon.canonSha256,
    machineProjectionSha256: machine.projectionSha256,
  }) as FoundationCanonReportV1;
  return { machine, report };
}

/**
 * Advisory Markdown view bound to the machine projection digest. Never a source
 * of truth and never an authority grant.
 */
export function renderFoundationCanonMarkdown(value: unknown): string {
  const { machine, report } = projectFoundationCanonSurfaces(value);
  const lines = [
    `# Foundation canon ${report.canonId} (${report.version})`,
    "",
    "Advisory projection only. Machine JSON is authoritative for identity.",
    "",
    `- State: ${report.state}`,
    `- Repository revision: ${report.repositoryRevision}`,
    `- Claims: ${report.claimCount}`,
    `- Conflicts: ${report.conflictCount}`,
    `- Gaps: ${report.gapCount}`,
    `- Affected documents: ${report.affectedDocumentCount}`,
    `- Authority present: ${report.hasAuthority ? "yes" : "no"}`,
    `- Supersedes prior: ${report.supersedes ? "yes" : "no"}`,
    `- Canon digest: ${report.canonSha256}`,
    `- Machine projection digest: ${machine.projectionSha256}`,
    `- Report digest: ${report.reportSha256}`,
  ];
  return `${lines.join("\n")}\n`;
}

/** Project from a durable stored artifact; rejects envelope tampering. */
export function projectFoundationCanonStoredArtifact(value: unknown): {
  machine: FoundationCanonProjectionV1;
  report: FoundationCanonReportV1;
  markdown: string;
  canonSha256: string;
} {
  kit.assertInert(value);
  kit.rejectCredentials(value);
  const root = kit.object(value);
  kit.exact(root, ["schemaVersion", "kind", "canon", "bindings", "storedArtifactSha256"]);
  if (root.schemaVersion !== 1 || root.kind !== "docsfab-foundation-canon-stored-artifact") {
    fail("invalid-value");
  }
  const surfaces = projectFoundationCanonSurfaces(root.canon);
  return {
    ...surfaces,
    markdown: renderFoundationCanonMarkdown(root.canon),
    canonSha256: surfaces.machine.canonSha256,
  };
}

export function assertProjectionRoundTrip(
  value: unknown,
  machine: FoundationCanonProjectionV1,
  report: FoundationCanonReportV1,
): void {
  const surfaces = projectFoundationCanonSurfaces(value);
  if (surfaces.machine.projectionSha256 !== machine.projectionSha256) fail("digest-mismatch");
  if (surfaces.report.reportSha256 !== report.reportSha256) fail("digest-mismatch");
  if (surfaces.machine.canonSha256 !== report.canonSha256) fail("digest-mismatch");
  if (report.machineProjectionSha256 !== machine.projectionSha256) fail("digest-mismatch");
}

function countGaps(canon: FoundationCanonV1): number {
  let gaps = 0;
  for (const claim of canon.claims) {
    if (claim.verificationStatus === "unverified") gaps += 1;
    if (claim.supersededByClaimId !== null) gaps += 1;
  }
  for (const conflict of canon.conflicts) {
    if (conflict.resolutionSha256 === null) gaps += 1;
  }
  return gaps;
}

function decodeOrFail(value: unknown): FoundationCanonV1 {
  try {
    return decodeFoundationCanon(value);
  } catch (error) {
    if (error instanceof FoundationCanonContractError) {
      fail(
        error.code === "migration-required"
          ? "migration-required"
          : error.code === "digest-mismatch"
            ? "digest-mismatch"
            : error.code === "credential-material"
              ? "credential-material"
              : error.code === "invalid-value"
                ? "invalid-value"
                : "invalid-shape",
      );
    }
    throw error;
  }
}

export type { FoundationCanonStoredArtifactV1 };
