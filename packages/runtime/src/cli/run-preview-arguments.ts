// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RunRequestWithPublishProjection } from "./run/request.js";

/** Reconstruct parser-admitted argv for the same run after removing --dry-run. */
export function runPreviewNextArguments(request: RunRequestWithPublishProjection): string[] {
  const args = ["run", request.workflow, "--repo", request.repositoryPath];
  if (request.revisionExplicit || request.comparisonRequest?.kind === "base-head") {
    args.push("--revision", request.revision);
  }
  if (request.instruction !== undefined) args.push("--instruction", request.instruction);
  if (request.compositionId !== undefined) args.push("--composition", request.compositionId);
  if (request.verbose) args.push("--verbose");
  if (request.quiet) args.push("--quiet");
  if (request.showScan) args.push("--show-scan");
  if (request.experimentalAnswerRecords) args.push("--experimental-answer-records");
  if (request.study) args.push("--study");
  if (request.releaseGate) args.push("--release-gate");
  if (request.resumeFrom !== undefined) args.push("--resume-from", request.resumeFrom);
  if (request.canonSnapshotPath !== undefined) {
    args.push("--canon-snapshot", request.canonSnapshotPath);
  }
  if (request.acceptCandidateSnapshot) args.push("--accept-candidate-snapshot");
  if (request.canonSnapshotAuthorityId !== undefined) {
    args.push("--authority-id", request.canonSnapshotAuthorityId);
  }
  if (request.contextTarget !== undefined) {
    args.push("--context-path", request.contextTarget.sourcePath);
    if (request.contextTarget.anchor !== undefined) {
      args.push("--context-anchor", request.contextTarget.anchor);
    }
    if (request.contextTarget.candidateParentPath !== undefined) {
      args.push("--context-parent-path", request.contextTarget.candidateParentPath);
    }
    if (request.contextTarget.candidateParentAnchor !== undefined) {
      args.push("--context-parent-anchor", request.contextTarget.candidateParentAnchor);
    }
  }
  if (request.docImprovementCampaignPath !== undefined) {
    args.push("--doc-improvement-campaign", request.docImprovementCampaignPath);
  }
  if (request.docImprovementReviewerPolicyPath !== undefined) {
    args.push("--reviewer-policy", request.docImprovementReviewerPolicyPath);
  }
  for (const sourcePath of request.sourcePaths ?? []) args.push("--source", sourcePath);
  for (const source of request.readerSources ?? []) {
    args.push("--reader-source", `${source.role}=${source.path}`);
  }
  const changeSource = request.changeSource;
  const changeSourceIsPullRequest = changeSource?.source === "github-pull-request";
  if (request.changeRequestSelector !== undefined) {
    args.push("--pr", changeRequestReference(request.changeRequestSelector));
  } else if (changeSourceIsPullRequest) {
    args.push("--pr", changeSourceReference(changeSource));
  }
  if (
    changeSource !== undefined &&
    !changeSourceIsPullRequest &&
    request.changeRequestSelector === undefined
  ) {
    args.push("--change", changeSourceReference(changeSource));
  }
  if (request.comparisonRequest?.kind === "base-head") {
    args.push("--comparison-base", request.comparisonRequest.baseRevision);
  } else if (request.comparisonRequest?.kind === "workspace") {
    args.push("--comparison-workspace");
  }
  if (request.remoteName !== undefined) args.push("--remote", request.remoteName);
  return args;
}

function changeRequestReference(selector: {
  readonly host: string | null;
  readonly projectPath: string | null;
  readonly number: number;
}): string {
  return selector.host === null || selector.projectPath === null
    ? String(selector.number)
    : `${selector.host}/${selector.projectPath}!${selector.number}`;
}

function changeSourceReference(
  selector: NonNullable<RunRequestWithPublishProjection["changeSource"]>,
): string {
  switch (selector.source) {
    case "local-range":
      return selector.form === "single-commit"
        ? selector.head
        : `${selector.base}${selector.form === "three-dot" ? "..." : ".."}${selector.head}`;
    case "gitlab-merge-request":
      return changeRequestReference(selector.changeRequest);
    case "github-pull-request":
      return `https://${selector.host}/${selector.owner}/${selector.repository}/pull/${selector.number}`;
    case "github-commit":
      return `https://${selector.host}/${selector.owner}/${selector.repository}/commit/${selector.commit}`;
    case "github-compare":
      return `https://${selector.host}/${selector.owner}/${selector.repository}/compare/${selector.base}${selector.form === "three-dot" ? "..." : ".."}${selector.head}`;
    case "release-range":
      return `release:${selector.base}..${selector.head}`;
  }
}
