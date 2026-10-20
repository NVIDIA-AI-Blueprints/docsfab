// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ChangeEvidence } from "../impact/contracts.js";

export interface RepositoryTarget {
  sourcePath: string;
  requestedRevision: string;
  revision: string;
  /** GitLab target-branch HEAD observed before a `--draft-mr` write, when sealed. */
  gitlabTargetRevision?: string;
  gitlabTargetBranch?: string;
}

/** Host-controlled immutable patch artifact slot for a create run. */
export type RepositoryCandidateArtifactKind = "candidate0" | "candidate1" | "failed-partial";

export interface RepositoryCandidateArtifactIdentityV1 {
  readonly kind: RepositoryCandidateArtifactKind;
}

export interface RepositoryEvidenceContext {
  runId: string;
  repository: RepositoryTarget;
  workspacePath: string;
  persistPatch: boolean;
  /** Optional immutable candidate slot; omitted for ordinary `${runId}.patch`. */
  candidateArtifact?: RepositoryCandidateArtifactIdentityV1;
}
export interface RepositoryEvidenceCollector {
  capture(
    context: RepositoryEvidenceContext,
  ): Promise<import("../impact/contracts.js").ChangeEvidence>;
}

/** Paths whose repository bytes a change record says were written or removed. */
export function repositoryChangeWriteEffectPaths(
  files: ChangeEvidence["files"],
): readonly string[] {
  return files.flatMap((file) =>
    file.status === "copied"
      ? [file.path]
      : [file.path, ...(file.previousPath ? [file.previousPath] : [])],
  );
}

/**
 * Part of a detected change cannot be represented against the source revision.
 * Carries the valid evidence so callers can record the partial patch and fail closed.
 */
export class RepositoryEvidenceProvenanceError extends Error {
  public readonly evidence: ChangeEvidence;
  public readonly code = "unrepresentable-runtime-change" as const;
  public constructor(evidence: ChangeEvidence) {
    super(
      "Repository evidence found a runtime bookkeeping change that cannot be represented against the original source baseline.",
    );
    this.evidence = evidence;
    this.name = "RepositoryEvidenceProvenanceError";
  }
}
