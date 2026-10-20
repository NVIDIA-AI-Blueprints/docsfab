// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const SCM_DELIVERY_STATES = [
  "planned",
  "prepared",
  "validated",
  "committed",
  "pushed",
  "opened",
] as const;
export type ScmDeliveryState = (typeof SCM_DELIVERY_STATES)[number];

export const SCM_DELIVERY_DISPOSITIONS = ["active", "failed", "succeeded", "recovered"] as const;
export type ScmDeliveryDisposition = (typeof SCM_DELIVERY_DISPOSITIONS)[number];

export const SCM_DELIVERY_FAILURE_CODES = [
  "prepare-failed",
  "validation-failed",
  "validation-isolation-unavailable",
  "commit-failed",
  "push-failed",
  "merge-request-open-failed",
  "authentication-unavailable",
  "authentication-revoked",
  "remote-drift",
  "remote-branch-deleted",
  "merge-request-closed",
  "merge-request-changed",
  "receipt-drift",
  "revision-mr-not-open",
  "git-identity-drift",
  "git-configuration-refused",
  "git-checkout-unverified",
] as const;
export type ScmDeliveryFailureCode = (typeof SCM_DELIVERY_FAILURE_CODES)[number];

export const SCM_DELIVERY_NEXT_ACTIONS = [
  "prepare-worktree",
  "run-validation",
  "create-commit",
  "push-branch",
  "open-draft-merge-request",
  "review-worktree",
  "fix-validation",
  "configure-validation-isolation",
  "retry-commit",
  "retry-push",
  "retry-open-draft-merge-request",
  "restore-authentication",
  "restore-remote-branch",
  "review-closed-merge-request",
  "reconcile-external-state",
  "review-preserved-patch",
  "none",
  "restore-git-identity",
  "remove-unsafe-git-configuration",
  "repair-git-checkout",
] as const;
export type ScmDeliveryNextAction = (typeof SCM_DELIVERY_NEXT_ACTIONS)[number];

export const SCM_RECONCILIATION_DECISIONS = [
  "resume-prepare",
  "resume-validation",
  "resume-commit",
  "resume-push",
  "resume-open-merge-request",
  "reuse-opened",
  "recover-patch-only",
  "blocked",
] as const;
export type ScmReconciliationDecision = (typeof SCM_RECONCILIATION_DECISIONS)[number];
