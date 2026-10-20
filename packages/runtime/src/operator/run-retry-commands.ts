// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { commandLineSettings } from "../config/model-settings.js";
import type { RunRecord } from "../records/contracts.js";
import { isCliRunRetryContextV1 } from "../records/retry-context.js";
import { retainedOperatorReviewTargets } from "./recovery-scope.js";

export function shellArgument(value: string): string {
  return /^[A-Za-z0-9_.\-/:@]+$/u.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

export function buildRunRetryCommand(record: RunRecord): string {
  return `docsfab run ${record.workflow} --repo '<original target checkout>' --instruction '<repeat the original approved instruction>' --patch-only`;
}

/**
 * The failed run's `--set` pairs, which a retry repeats so it binds the same
 * settings. A shown command never prints a `--set` endpoint, so a run that set
 * one is inspected instead of retried from the shown line.
 */
function retrySettings(record: RunRecord): {
  readonly sets: readonly string[];
  readonly endpointWithheld: boolean;
} {
  const { sets } = commandLineSettings(record.modelSettings?.writing);
  return { sets, endpointWithheld: sets.some((pair) => pair.startsWith("baseUrl=")) };
}

export function buildProviderRetryCommand(record: RunRecord, stateDirArg: string): string {
  const context = record.retryContext;
  const settings = retrySettings(record);
  if (!isCliRunRetryContextV1(context) || !context.reconstructable || settings.endpointWithheld) {
    return `docsfab runs show ${shellArgument(record.id)}${stateDirArg} --json`;
  }
  const retainedTargets =
    record.workflow === "review-documentation" && record.reviewScope
      ? retainedOperatorReviewTargets(record)
      : undefined;
  if (record.reviewScope && record.workflow === "review-documentation" && !retainedTargets) {
    return `docsfab runs show ${shellArgument(record.id)}${stateDirArg} --json`;
  }
  if (
    retainedTargets &&
    context.contextTarget &&
    (retainedTargets.length !== 1 || retainedTargets[0] !== context.contextTarget.sourcePath)
  ) {
    return `docsfab runs show ${shellArgument(record.id)}${stateDirArg} --json`;
  }
  const arguments_ = ["docsfab", "run", record.workflow, "--repo", record.repository.sourcePath];
  if (context.compositionId !== undefined) arguments_.push("--composition", context.compositionId);
  for (const pair of settings.sets) arguments_.push("--set", pair);
  if (context.experimentalAnswerRecords) arguments_.push("--experimental-answer-records");
  if (context.contextTarget) {
    arguments_.push("--context-path", context.contextTarget.sourcePath);
    if (context.contextTarget.anchor !== undefined) {
      arguments_.push("--context-anchor", context.contextTarget.anchor);
    }
    if (context.contextTarget.candidateParentPath !== undefined) {
      arguments_.push("--context-parent-path", context.contextTarget.candidateParentPath);
    }
    if (context.contextTarget.candidateParentAnchor !== undefined) {
      arguments_.push("--context-parent-anchor", context.contextTarget.candidateParentAnchor);
    }
  }
  // A failed review's admitted page set is authoritative. Replaying only its
  // prose could widen or narrow the scope as the parser changes, especially
  // when supporting pages appear after "using" in the instruction.
  if (retainedTargets && !context.contextTarget) {
    for (const path of retainedTargets) arguments_.push("--review-target", path);
  }
  // The selected checkout can move after the failed run. A same-scope retry
  // must bind the revision the run actually inspected, including when the
  // original CLI omitted --revision or selected a symbolic ref such as HEAD.
  arguments_.push("--revision", record.repository.revision);
  if (context.instructionPresent && record.instruction !== undefined) {
    arguments_.push("--instruction", record.instruction);
  } else if (context.instructionPresent) {
    return `docsfab runs show ${shellArgument(record.id)}${stateDirArg} --json`;
  }
  if (context.comparisonRequest?.kind === "workspace") arguments_.push("--comparison-workspace");
  if (context.comparisonRequest?.kind === "base-head") {
    arguments_.push("--comparison-base", context.comparisonRequest.baseRevision);
  }
  for (const source of context.readerSources ?? []) {
    arguments_.push("--reader-source", `${source.role}=${source.path}`);
  }
  for (const sourcePath of context.sourcePaths ?? []) arguments_.push("--source", sourcePath);
  if (context.docImprovementCampaignPath !== undefined) {
    arguments_.push("--doc-improvement-campaign", context.docImprovementCampaignPath);
  }
  if (context.docImprovementReviewerPolicyPath !== undefined) {
    arguments_.push("--reviewer-policy", context.docImprovementReviewerPolicyPath);
  }
  if (context.canonSnapshotPath !== undefined)
    arguments_.push("--canon-snapshot", context.canonSnapshotPath);
  if (context.acceptCandidateSnapshot) arguments_.push("--accept-candidate-snapshot");
  if (context.canonSnapshotAuthorityId !== undefined) {
    arguments_.push("--authority-id", context.canonSnapshotAuthorityId);
  }
  if (context.releaseGate) arguments_.push("--release-gate");
  if (context.study) arguments_.push("--study");
  switch (context.deliveryMode) {
    case "dry-run":
      arguments_.push("--dry-run");
      break;
    case "patch-only":
      if (context.writeGrantExplicit) arguments_.push("--allow-write");
      arguments_.push("--patch-only");
      break;
    case "draft-mr":
      arguments_.push("--draft-mr");
      if (context.remoteName !== undefined) arguments_.push("--remote", context.remoteName);
      break;
    case "comment-mr":
      if (context.commentMr === undefined) {
        return `docsfab runs show ${shellArgument(record.id)}${stateDirArg} --json`;
      }
      if (context.writeGrantExplicit) arguments_.push("--allow-write");
      arguments_.push("--comment-mr", context.commentMr);
      if (context.commentMrCanonSha256 !== undefined) {
        arguments_.push("--canon-sha256", context.commentMrCanonSha256);
      }
      break;
    case "write-only":
      if (context.writeGrantExplicit) arguments_.push("--allow-write");
      break;
    case "read-only":
      break;
  }
  return arguments_.map(shellArgument).join(" ");
}

export function retryRecoveryReason(record: RunRecord, reason: string): string {
  if (!isCliRunRetryContextV1(record.retryContext) || !record.retryContext.reconstructable) {
    return `${reason} The original CLI selection is not retained well enough to reconstruct a safe retry; inspect the saved run before retrying.`;
  }
  const targets =
    record.workflow === "review-documentation" && record.reviewScope
      ? retainedOperatorReviewTargets(record)
      : undefined;
  if (record.workflow === "review-documentation" && record.reviewScope && !targets) {
    return `${reason} The saved review scope cannot be reconstructed safely; inspect the run and select a new explicit batch.`;
  }
  const scope =
    record.workflow === "review-documentation"
      ? ` Same-scope retry at ${record.repository.revision}: ${targets ? targets.join(", ") : "the saved whole documentation set"}. Rescope is a separate operator-selected batch, not a change inferred from advice.`
      : "";
  return retrySettings(record).endpointWithheld
    ? `${reason} The run set its endpoint with --set baseUrl, which a shown command does not repeat; retry with the --set values the saved run records.`
    : `${reason}${scope}`;
}

export function buildGovernedInputRetryTemplate(record: RunRecord): string {
  return `docsfab run ${record.workflow} --repo '<original target checkout>' --instruction '<amended instruction with required governed input>' --patch-only`;
}
