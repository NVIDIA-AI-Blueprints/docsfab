// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  authorityPolicy,
  createFallback,
  decodeUpdateExistingMrRequest,
  fail,
  normalizeUpdateExistingMrObservation,
  normalizeUpdateExistingMrGrant,
  sealEvaluation,
  type UpdateExistingMrAuthorityV1,
  type UpdateExistingMrEvaluationV1,
  type UpdateExistingMrGrantV1,
  type UpdateExistingMrRequestV1,
  type UpdateExistingMrScmObservationV1,
} from "./contracts.js";

/**
 * Intersects the sealed request, opaque authority, standing Contribute grant,
 * and a fresh host-vouched SCM observation. A denial always carries the typed
 * comment-only fallback and never upgrades to a replacement MR or force push.
 * Host evaluation calls this function; it must not fork a second policy.
 */
export function evaluateUpdateExistingMr(input: {
  request: UpdateExistingMrRequestV1;
  authority: UpdateExistingMrAuthorityV1 | null | undefined;
  grant: UpdateExistingMrGrantV1 | null | undefined;
  observation: UpdateExistingMrScmObservationV1;
}): UpdateExistingMrEvaluationV1 {
  const request = decodeUpdateExistingMrRequest(input.request);
  const fallback = createFallback(request);
  const policy = input.authority ? authorityPolicy(input.authority) : undefined;
  const observation = normalizeUpdateExistingMrObservation(input.observation);
  const grant = input.grant ? normalizeUpdateExistingMrGrant(input.grant) : null;
  let reason: UpdateExistingMrEvaluationV1["reason"] = "allowed";

  if (!policy) reason = "authority-required";
  else if (!grant) reason = "grant-required";
  else if (request.forcePush !== false) reason = "force-push-forbidden";
  else if (request.policyVersion !== policy.policyVersion) reason = "policy-mismatch";
  else if (request.project.host !== policy.host || observation.host !== policy.host)
    reason = "project-mismatch";
  else if (
    request.project.projectId !== policy.projectId ||
    observation.projectId !== policy.projectId
  ) {
    reason = "project-mismatch";
  } else if (
    request.mergeRequest.iid !== policy.mergeRequestIid ||
    observation.mergeRequestIid !== policy.mergeRequestIid
  ) {
    reason = "merge-request-mismatch";
  } else if (
    request.mergeRequest.sourceProjectId !== policy.sourceProjectId ||
    observation.sourceProjectId !== policy.sourceProjectId ||
    observation.sourceProjectId !== observation.projectId
  ) {
    reason = "fork-not-allowed";
  } else if (
    request.mergeRequest.sourceBranch !== policy.sourceBranch ||
    observation.sourceBranch !== policy.sourceBranch
  ) {
    reason = "source-branch-mismatch";
  } else if (
    request.mergeRequest.targetBranch !== policy.targetBranch ||
    observation.targetBranch !== policy.targetBranch
  ) {
    reason = "target-branch-mismatch";
  } else if (observation.sourceProtected) reason = "protected-branch";
  else if (observation.sourceIsDefault || observation.sourceBranch === observation.defaultBranch) {
    reason = "default-branch";
  } else if (
    request.mergeRequest.sourceOwnerIdentity !== policy.sourceOwnerIdentity ||
    observation.sourceOwnerIdentity !== policy.sourceOwnerIdentity
  ) {
    reason = "owner-not-allowed";
  } else if (request.mergeRequest.expectedHeadSha !== policy.expectedHeadSha) {
    reason = "stale-head";
  } else if (observation.headSha !== request.mergeRequest.expectedHeadSha) {
    reason = "stale-head";
  } else if (
    grant.host !== request.project.host ||
    grant.projectId !== request.project.projectId ||
    grant.mergeRequestIid !== request.mergeRequest.iid ||
    grant.sourceBranch !== request.mergeRequest.sourceBranch ||
    grant.targetBranch !== request.mergeRequest.targetBranch ||
    grant.expectedHeadSha !== request.mergeRequest.expectedHeadSha ||
    grant.requesterIdentitySha256 !== request.requesterIdentitySha256 ||
    grant.policyVersion !== request.policyVersion
  ) {
    reason = "policy-mismatch";
  } else if (request.requesterIdentitySha256 !== policy.requesterIdentitySha256) {
    reason = "requester-mismatch";
  }

  return sealEvaluation({
    requestSha256: request.requestSha256,
    decision: reason === "allowed" ? "allow" : "deny",
    reason,
    projectId: request.project.projectId,
    mergeRequestIid: request.mergeRequest.iid,
    expectedHeadSha: request.mergeRequest.expectedHeadSha,
    observedHeadSha: observation.headSha,
    grantVersion: grant?.grantVersion ?? null,
    fallback,
  });
}

export function assertUpdateExistingMrAllowed(evaluation: UpdateExistingMrEvaluationV1): void {
  if (evaluation.decision === "allow" && evaluation.reason === "allowed") return;
  if (evaluation.reason === "allowed") fail("invalid-value");
  fail(evaluation.reason);
}
