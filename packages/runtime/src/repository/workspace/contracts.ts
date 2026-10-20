// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Registered, callback-scoped export of one authenticated GitHub PR head tree. */
export interface GithubPrHeadWorkspace extends RepositoryWorkspace {
  readonly sourceKind: "github-pr-head";
  readonly sourceIdentitySha256: string;
  readonly targetRepositoryId: number;
  readonly headRepositoryId: number;
  readonly B: string;
  readonly H: string;
  readonly M: string;
  readonly headTree: string;
  readonly headEntriesSha256: string;
  readonly manifestSha256: string;
}

export interface RepositoryWorkspace {
  readonly path: string;
  readonly sourcePath: string;
  readonly requestedRevision: string;
  readonly revision: string;
  dispose(): Promise<void>;
}

/**
 * The ceilings one workspace export runs under. Each comes from a catalog limit
 * in `config/limits/repository.yaml` (`repositoryWorkspaceExportLimits`), which
 * a host may raise or lower; a caller may only tighten them further.
 */
export interface RepositoryWorkspaceMaterializationLimits {
  /** `repository.workspaceExportMaxTreeEntries`; past it, `file-count-limit`. */
  readonly maxTreeEntries: number;
  /** `repository.workspaceExportMaxAggregateBytes`; past it, `aggregate-byte-limit`. */
  readonly maxAggregateBytes: number;
  /** `repository.workspaceExportMaxScratchBytes`; past it, `scratch-space-limit`. */
  readonly maxScratchBytes: number;
  /** `repository.workspaceExportMaxTreeMetadataBytes`; past it, `tree-metadata-limit`. */
  readonly maxTreeMetadataBytes: number;
  /**
   * `repository.workspaceExportStallMs`: longest the export may go without
   * progress. It is not a wall clock: every finished Git read, tree-listing
   * chunk, created directory, written chunk of file bytes, and verified file
   * restarts it, so a slow export that keeps moving is never stopped.
   */
  readonly maxStallMs: number;
}

/**
 * `per-blob-timeout` and `aggregate-timeout` both mean the export made no
 * progress for `maxStallMs`: the first while a file's bytes were streaming from
 * git, the second anywhere else.
 */
export type RepositoryWorkspaceMaterializationFailureCode =
  | "file-count-limit"
  | "aggregate-byte-limit"
  | "scratch-space-limit"
  | "tree-metadata-limit"
  | "per-blob-timeout"
  | "aggregate-timeout"
  | "git-blob-failed"
  | "filesystem-path-collision"
  | "materialization-failed";

export interface RepositoryWorkspaceMaterializationFailureEvidence {
  readonly schemaVersion: 1;
  readonly kind: "docsfab-repository-workspace-materialization-failure";
  readonly code: RepositoryWorkspaceMaterializationFailureCode;
  readonly phase: "preflight" | "materialization" | "verification";
  readonly quantity: Readonly<{
    unit: "files" | "bytes" | "milliseconds";
    limit: string;
    observed: string;
  }> | null;
  readonly children: Readonly<{
    started: number;
    cancellationRequested: number;
    reaped: number;
  }>;
}

function formatMaterializationFailureMessage(
  evidence: RepositoryWorkspaceMaterializationFailureEvidence,
  limitRefusal: string | undefined,
): string {
  const quantity = evidence.quantity;
  const quantityText =
    quantity === null
      ? ""
      : ` (observed ${quantity.observed} ${quantity.unit}, limit ${quantity.limit} ${quantity.unit})`;
  const message = `Repository workspace materialization failed: ${evidence.code} during ${evidence.phase}${quantityText}.`;
  return limitRefusal === undefined ? message : `${message} ${limitRefusal}`;
}

/** Content-free host evidence for a bounded exact-tree export failure. */
export class RepositoryWorkspaceMaterializationError extends Error {
  public readonly code: RepositoryWorkspaceMaterializationFailureCode;
  public readonly evidence: RepositoryWorkspaceMaterializationFailureEvidence;
  /**
   * The catalog refusal line of the operational limit that stopped the export,
   * when one did. It names the limit's refusal code, the observed value, the
   * limit, and its remediation, and follows the evidence sentence in the
   * message.
   */
  public readonly limitRefusal: string | undefined;

  public constructor(
    evidence: RepositoryWorkspaceMaterializationFailureEvidence,
    limitRefusal?: string,
  ) {
    super(formatMaterializationFailureMessage(evidence, limitRefusal));
    this.name = "RepositoryWorkspaceMaterializationError";
    this.code = evidence.code;
    this.limitRefusal = limitRefusal;
    this.evidence = Object.freeze({
      ...evidence,
      quantity: evidence.quantity === null ? null : Object.freeze({ ...evidence.quantity }),
      children: Object.freeze({ ...evidence.children }),
    });
  }
}

export interface RepositoryWorkspacePreparationOptions {
  /** May only tighten the effective catalog ceilings, host overrides included. */
  limits?: Partial<RepositoryWorkspaceMaterializationLimits>;
}

export type TrackedWorkspaceEntryKind = "regular" | "symlink" | "submodule" | "excluded";

export interface TrackedRepositoryFile {
  path: string;
  byteLength: number;
}

/** Content-minimized tree entry used by host-side structural indexers. */
export interface TrackedRepositoryEntry {
  /** Omitted for security-excluded entries so secret-looking names do not escape. */
  path?: string;
  kind: TrackedWorkspaceEntryKind;
  byteLength?: number;
}

export interface TrackedRepositoryEntryVerification {
  /** Omitted for security-excluded entries. */
  path?: string;
  kind: TrackedWorkspaceEntryKind;
  status: "verified" | "changed";
}

export class RepositoryWorkspaceReadError extends Error {
  public readonly code: "not-tracked" | "unsafe-kind" | "oversize" | "changed" | "read-failed";
  public constructor(
    code: "not-tracked" | "unsafe-kind" | "oversize" | "changed" | "read-failed",
    details?: { path: string; observedBytes: number; limitBytes: number; remediation: string },
  ) {
    super(
      `Tracked repository file read failed: ${code}.` +
        (details
          ? ` Observed ${details.observedBytes} bytes for ${details.path}; limit ${details.limitBytes} bytes. ${details.remediation}`
          : ""),
    );
    this.code = code;
    this.name = "RepositoryWorkspaceReadError";
  }
}
