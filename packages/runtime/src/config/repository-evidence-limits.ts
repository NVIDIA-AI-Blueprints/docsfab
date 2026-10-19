// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Operational bounds for the git commands that record a run's workspace
 * evidence (`GitPatchEvidenceCollector`), projected from the operational-limits
 * catalog. A host may raise or lower each one.
 */
import { limit, type ResolveLimitsOptions, type ResolvedLimit } from "./limits.js";

export const REPOSITORY_EVIDENCE_GIT_LIMITS = Object.freeze({
  timeoutMs: "repository.evidenceGitTimeoutMs",
  outputMaxBytes: "repository.evidenceGitOutputMaxBytes",
} as const);

export interface RepositoryEvidenceGitLimitsV1 {
  /** Longest one evidence git command may run. */
  readonly timeoutMs: ResolvedLimit;
  /** Most bytes one evidence git command may write to stdout or to stderr. */
  readonly outputMaxBytes: ResolvedLimit;
}

/** Both evidence git limits, with any host override applied. */
export function repositoryEvidenceGitLimits(
  options?: ResolveLimitsOptions,
): RepositoryEvidenceGitLimitsV1 {
  return Object.freeze({
    timeoutMs: limit(REPOSITORY_EVIDENCE_GIT_LIMITS.timeoutMs, options),
    outputMaxBytes: limit(REPOSITORY_EVIDENCE_GIT_LIMITS.outputMaxBytes, options),
  });
}
