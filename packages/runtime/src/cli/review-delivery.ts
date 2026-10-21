// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Read-only fresh GitLab review-delivery binding. CLI intent never comes from a run record. */
import { resolve } from "node:path";
import { DurableArtifactStore } from "../artifacts/store.js";
import type { ResolveLimitsOptions } from "../config/limits.js";
import type { AcquiredChangeSourceV1 } from "../inputs/change-source/acquisition.js";
import {
  decodeChangeSourceV1,
  type ResolvedChangeSourceV1,
  type ChangeSourceMemberV1,
  type ChangeSourceV1,
} from "../inputs/change-source.js";
import { decodeSuccessfulReviewRunRecord } from "../delivery/run-record.js";
import { createWorkspaceOriginalSideReader } from "../inputs/change-source/original-side-reader.js";
import { reviewResultFromRun } from "../review/run-result.js";
import { createReviewTargetV2 } from "../review/target-migration.js";
import type { ReviewTargetV2 } from "../review/contracts.js";
import { retainReviewDeliverySourceSnapshot } from "../review-delivery/source-snapshot-writer.js";
import { createReviewChangeSource } from "../harness/confined-tools/review-change-side.js";
import { planRetainedReviewDelivery } from "../review-delivery/public.js";
import type { ReviewDeliveryPlan } from "../review-delivery/contracts.js";
import { loadRetainedReviewResult } from "../review-delivery/result-store.js";
import { FileRunStore } from "../records/file-store.js";
import type { RunRecord } from "../records/contracts.js";
import {
  decodeSourceBinding,
  type SourceBindingV1,
  type SourceRepositoryBindingV1,
} from "../inputs/source-evidence.js";
import type { WorkflowRunnerOptions } from "../workflow-execution/runner-ports.js";
import { ExecInitCommandRunner } from "../init/shared.js";
import type { ReadOnlyCommandRunner } from "../delivery/preflight.js";
import { observeCommentExistingMrWithGlab } from "./comment-existing-mr-glab.js";
import { parseCommentMrTarget } from "./comment-existing-mr-target.js";
import { ReviewDeliveryCliOperatorError } from "./review-delivery-error.js";
import { redactCredentialMaterial } from "../security/credential-material.js";
import { escapeUndisplayable } from "../shared/display-text.js";

export interface FreshGitLabReviewBinding {
  readonly target: ReviewTargetV2;
  readonly source: ChangeSourceV1;
}

/** Bind the writer to the exact source service reference before any model call. */
export function assertFreshGitLabSourceBinding(input: {
  readonly binding: SourceBindingV1;
  readonly referenceDigest: string;
  readonly repository: SourceRepositoryBindingV1;
  readonly reviewedHead: string;
}): void {
  const binding = decodeSourceBinding(input.binding);
  if (
    binding.bindingSha256 !== input.referenceDigest ||
    binding.repository.identitySha256 !== input.repository.identitySha256 ||
    binding.repository.revision !== input.repository.revision ||
    binding.repository.revision !== input.reviewedHead
  ) {
    throw new ReviewDeliveryCliOperatorError("source-binding-mismatch");
  }
}

export async function prepareFreshGitLabReviewDelivery(input: {
  readonly targetUrl: string;
  readonly sourcePath: string;
  readonly runId: string;
  readonly resolved: ResolvedChangeSourceV1<ChangeSourceMemberV1>;
  readonly acquired: AcquiredChangeSourceV1;
  readonly runSourceBinding: SourceBindingV1;
  readonly artifacts: DurableArtifactStore;
  readonly commands?: ReadOnlyCommandRunner;
  readonly signal?: AbortSignal;
  readonly limits?: ResolveLimitsOptions;
}): Promise<{
  readonly binding: FreshGitLabReviewBinding;
  readonly reviewChangeSource: NonNullable<WorkflowRunnerOptions["reviewChangeSource"]>;
  readonly retention: NonNullable<WorkflowRunnerOptions["reviewResultRetention"]>;
}> {
  const parsed = parseCommentMrTarget(input.targetUrl);
  if (parsed.kind !== "url") throw new ReviewDeliveryCliOperatorError("target-url-required");
  const source = decodeChangeSourceV1(input.resolved.changeSource);
  const member = source.source;
  if (
    member.kind !== "gitlab-merge-request" ||
    member.host !== parsed.host ||
    member.projectPath !== parsed.projectPath ||
    member.iid !== parsed.mergeRequestIid
  ) {
    throw new ReviewDeliveryCliOperatorError("target-source-mismatch");
  }
  const observed = await observeCommentExistingMrWithGlab(
    { target: parsed, repositoryPath: input.sourcePath },
    input.commands ?? new ExecInitCommandRunner(),
  );
  if (
    observed.proofStatus !== "current" ||
    observed.host !== member.host ||
    observed.projectId !== member.projectId ||
    observed.mergeRequestIid !== member.iid ||
    observed.headSha !== member.diffRefs.head ||
    source.revision.head !== observed.headSha
  ) {
    throw new ReviewDeliveryCliOperatorError("target-stale");
  }
  const target = createReviewTargetV2(
    {
      scmProvider: "gitlab",
      host: observed.host,
      projectId: observed.projectId,
      mergeRequestIid: observed.mergeRequestIid,
      sourceFork: member.fork,
      sourceBranch: observed.sourceBranch,
      targetBranch: observed.targetBranch,
      baseSha: member.diffRefs.base,
      headSha: observed.headSha,
      trigger: "interactive",
      requestIdentitySha256: observed.requestIdentitySha256,
      workflow: "review-documentation",
      deliveryIntent: "comment-existing-mr",
      logicalRequestId: input.runId,
      changeSourceSha256: source.changeSourceSha256,
    },
    source,
  );
  const sourceReference = await retainReviewDeliverySourceSnapshot({
    runId: input.runId,
    resolved: input.resolved as ResolvedChangeSourceV1,
    acquired: input.acquired,
    runSourceBinding: input.runSourceBinding,
    artifacts: input.artifacts,
    readOriginal: createWorkspaceOriginalSideReader({
      sourcePath: input.sourcePath,
      objectFormat: source.objectFormat,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.limits ? { limits: input.limits } : {}),
    }),
    ...(input.limits ? { limits: input.limits } : {}),
  });
  const reviewChangeSource = await createReviewChangeSource({
    artifacts: input.artifacts,
    reference: sourceReference,
    source,
  });
  return {
    binding: { target, source },
    reviewChangeSource,
    retention: {
      artifacts: input.artifacts,
      prepare: async (record: Readonly<RunRecord>) => ({
        originalResult: reviewResultFromRun(record as RunRecord, { target, source }),
        sourceReference,
      }),
    },
  };
}

export async function previewFreshGitLabReviewDelivery(input: {
  readonly stateDirectory: string;
  readonly runId: string;
  readonly binding: FreshGitLabReviewBinding;
}) {
  const runStore = new FileRunStore(input.stateDirectory);
  const artifacts = new DurableArtifactStore(resolve(input.stateDirectory, "..", "artifacts"));
  const loaded = await loadRetainedReviewResult({
    runStore,
    artifacts,
    runId: input.runId,
    target: input.binding.target,
    readOnly: true,
  });
  const run = await runStore.getWithDigest(input.runId, { readOnly: true });
  const resultUse = decodeSuccessfulReviewRunRecord(run.record).artifacts?.find(
    (use) => use.reference.kind === "review-result",
  );
  if (!resultUse) throw new ReviewDeliveryCliOperatorError("result-artifact-unavailable");
  return planRetainedReviewDelivery({
    stateDirectory: input.stateDirectory,
    runId: input.runId,
    binding: input.binding,
    delivery: {
      snapshot: loaded.source.snapshot,
      artifact: {
        kind: "retained-review-result",
        id: resultUse.reference.digest,
        resultSha256: loaded.result.resultSha256,
      },
      actor: { host: input.binding.target.host, id: input.binding.target.requestIdentitySha256 },
      capabilities: {
        scmProvider: "gitlab",
        host: input.binding.target.host,
        summary: true,
        inline: true,
      },
    },
    readOnly: true,
  });
}

/** Show the complete read-only plan as inert operator text; data never selects an effect. */
export function formatFreshGitLabReviewPreview(plan: ReviewDeliveryPlan): string {
  const shown = (value: string): string =>
    escapeUndisplayable(JSON.stringify(redactCredentialMaterial(value)));
  const target =
    plan.target.scmProvider === "gitlab"
      ? `${shown(plan.target.host)} MR !${plan.target.mergeRequestIid}`
      : shown(plan.target.host);
  const lines = [
    `Review delivery preview: ${plan.actions.length} planned actions for ${target}; no forge write was made.`,
    `Reviewed head: ${shown(plan.result.reviewedHeadSha)}`,
  ];
  const plannedFindingIds = new Set<string>();
  for (const action of plan.actions) {
    if (action.kind === "publish-summary") {
      for (const id of action.findingIds) plannedFindingIds.add(id);
      lines.push(
        `Action publish-summary: findings ${action.findingIds.map(shown).join(", ") || "none"}`,
      );
    } else {
      plannedFindingIds.add(action.findingId);
      lines.push(
        `Action publish-inline: finding ${shown(action.findingId)} at ${shown(action.anchor.path)} ${action.anchor.side} ${action.anchor.startLine}-${action.anchor.endLine}`,
      );
    }
  }
  for (const finding of plan.findings) {
    const disposition = finding.disposition;
    const reason =
      disposition.kind === "inline-candidate" ? "" : `; reason ${shown(disposition.reason)}`;
    lines.push(
      `Finding ${shown(finding.inventoryId)} (${finding.severity}, ${plannedFindingIds.has(finding.inventoryId) ? "planned" : "withheld"}): ${disposition.kind}${reason}`,
      `  Path: ${finding.path === null ? "none" : shown(finding.path)}`,
      `  Text: ${shown(finding.text)}`,
    );
    for (const limitation of finding.limitations)
      lines.push(`  Finding limitation: ${shown(limitation)}`);
  }
  for (const check of plan.checks) lines.push(`Check ${shown(check.name)}: ${check.status}`);
  for (const question of plan.unresolvedQuestions)
    lines.push(`Open question: ${shown(question.summary)}`);
  for (const path of plan.affectedPaths) lines.push(`Affected path: ${shown(path)}`);
  for (const limitation of plan.limitations) lines.push(`Plan limitation: ${shown(limitation)}`);
  return lines.join("\n");
}
