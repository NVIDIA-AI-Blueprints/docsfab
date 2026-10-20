// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Local CLI composition for reviewing one existing merge request. */

import { canonicalDigest } from "../content-ir/canonical.js";
import type { RunRecord } from "../records/contracts.js";
import {
  REVIEW_DELIVERY_INTENT,
  createReviewTarget,
  ReviewRunHeadChangedError,
  reviewResultFromRun as projectReviewResultFromRun,
  type ReviewTargetV1,
} from "../review/index.js";
import type { WorkflowName } from "../workflow-contracts/contracts.js";
import type { ParsedCommentMrTarget } from "./comment-existing-mr-target.js";

export { parseCommentMrTarget } from "./comment-existing-mr-target.js";
export type { ParsedCommentMrTarget } from "./comment-existing-mr-target.js";
export { reviewCoverageFromRun, reviewResultInputFromRun } from "../review/index.js";

export interface ObservedMergeRequest {
  readonly host: string;
  readonly projectId: number;
  readonly mergeRequestIid: number;
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly headSha: string;
  readonly requestIdentitySha256: string;
  readonly proofStatus: "current";
}

export interface CommentExistingMrBinding {
  readonly target: ReviewTargetV1;
  readonly parsed: ParsedCommentMrTarget;
  readonly generation: 0 | 1;
}

export interface CommentExistingMrReceipt {
  readonly status: "projected";
  readonly mutation: string;
  readonly reviewedHeadSha: string;
  readonly mergeRequestIid: number;
  readonly noteId: string;
  readonly deliveryIntent: typeof REVIEW_DELIVERY_INTENT;
}

export interface CommentExistingMrMutations {
  commits: number;
  branches: number;
  pushes: number;
  mergeRequests: number;
}

export interface CommentExistingMrPort {
  readonly mutations: CommentExistingMrMutations;
  observe(input: {
    target: ParsedCommentMrTarget;
    repositoryPath: string;
  }): Promise<ObservedMergeRequest>;
  project(input: { target: unknown; result: unknown }): Promise<CommentExistingMrReceipt>;
}

export class CommentExistingMrHeadChangedError extends Error {
  readonly code = "mr-head-changed" as const;

  constructor(readonly next: ObservedMergeRequest) {
    super("Review summary rejected: mr-head-changed.");
    this.name = "CommentExistingMrHeadChangedError";
  }
}

export function emptyCommentExistingMrMutations(): CommentExistingMrMutations {
  return { commits: 0, branches: 0, pushes: 0, mergeRequests: 0 };
}

export function commentMrLogicalRequestId(
  workflow: WorkflowName,
  projectId: number,
  mergeRequestIid: number,
  generation: 0 | 1,
): string {
  const base = `cli-comment:${workflow}:${projectId}:${mergeRequestIid}`;
  return generation === 0 ? base : `${base}:r1`;
}

export function bindCommentExistingMrTarget(
  observed: ObservedMergeRequest,
  workflow: WorkflowName,
  generation: 0 | 1,
): CommentExistingMrBinding {
  const target = createReviewTarget({
    scmProvider: "gitlab",
    host: observed.host,
    projectId: observed.projectId,
    mergeRequestIid: observed.mergeRequestIid,
    sourceBranch: observed.sourceBranch,
    targetBranch: observed.targetBranch,
    headSha: observed.headSha,
    trigger: "interactive",
    requestIdentitySha256: observed.requestIdentitySha256,
    workflow,
    deliveryIntent: REVIEW_DELIVERY_INTENT,
    logicalRequestId: commentMrLogicalRequestId(
      workflow,
      observed.projectId,
      observed.mergeRequestIid,
      generation,
    ),
  });
  return {
    target,
    parsed: { kind: "iid", mergeRequestIid: observed.mergeRequestIid },
    generation,
  };
}

/** Compatibility entry point retained for the local CLI. */
export function reviewResultFromRun(
  record: RunRecord,
  binding: CommentExistingMrBinding,
  hostedReportUrl?: string,
  canonSha256?: string,
): ReturnType<typeof projectReviewResultFromRun> {
  try {
    return projectReviewResultFromRun(record, binding, hostedReportUrl, canonSha256);
  } catch (error) {
    if (!(error instanceof ReviewRunHeadChangedError)) throw error;
    throw new CommentExistingMrHeadChangedError({
      host: binding.target.host,
      projectId: binding.target.projectId,
      mergeRequestIid: binding.target.mergeRequestIid,
      sourceBranch: binding.target.sourceBranch,
      targetBranch: binding.target.targetBranch,
      headSha: error.actualRevision,
      requestIdentitySha256: binding.target.requestIdentitySha256,
      proofStatus: "current",
    });
  }
}

export function isCommentExistingMrHeadChanged(error: unknown): boolean {
  if (error instanceof CommentExistingMrHeadChangedError) return true;
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "mr-head-changed"
  );
}

export async function postCommentExistingMrReviewSummary(
  port: CommentExistingMrPort,
  binding: CommentExistingMrBinding,
  record: RunRecord,
  parsed: ParsedCommentMrTarget,
  repositoryPath: string,
  retried: boolean,
  hostedReportUrl?: string,
  canonSha256?: string,
): Promise<CommentExistingMrReceipt> {
  assertNoGitMutations(port.mutations);
  let result: ReturnType<typeof projectReviewResultFromRun>;
  try {
    result = reviewResultFromRun(record, binding, hostedReportUrl, canonSha256);
  } catch (error) {
    if (!isCommentExistingMrHeadChanged(error) || retried) throw error;
    const next = await port.observe({ target: parsed, repositoryPath });
    throw new CommentExistingMrHeadChangedError(next);
  }
  try {
    const receipt = await port.project({ target: binding.target, result });
    assertNoGitMutations(port.mutations);
    if (receipt.deliveryIntent !== REVIEW_DELIVERY_INTENT) {
      throw new Error(
        "comment-existing-mr receipt delivery intent did not match the review contract.",
      );
    }
    return receipt;
  } catch (error) {
    assertNoGitMutations(port.mutations);
    if (!isCommentExistingMrHeadChanged(error) || retried) throw error;
    const next = await port.observe({ target: parsed, repositoryPath });
    throw new CommentExistingMrHeadChangedError(next);
  }
}

export function assertNoGitMutations(mutations: CommentExistingMrMutations): void {
  if (
    mutations.commits !== 0 ||
    mutations.branches !== 0 ||
    mutations.pushes !== 0 ||
    mutations.mergeRequests !== 0
  ) {
    throw new Error(
      "comment-existing-mr must not create a commit, branch, push, or merge request.",
    );
  }
}

export function requestIdentitySha256FromBinding(
  host: string,
  projectId: number,
  mergeRequestIid: number,
): string {
  return canonicalDigest({ kind: "cli-local-user", host, projectId, mergeRequestIid });
}
