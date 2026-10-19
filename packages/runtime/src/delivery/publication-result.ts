// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const SAFE_BRANCH =
  /^(?![-.])(?!.*(?:\.\.|@\{|\\|[\x00-\x20~^:?*\[]))(?!.*\/$)(?!.*\.lock(?:\/|$))[A-Za-z0-9._/-]{1,200}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

export interface LocalUserGitLabPublicationResultV1 {
  schemaVersion: 1;
  kind: "docsfab-local-user-gitlab-publication-result";
  status: "opened";
  planSha256: string;
  idempotencyKey: string;
  receiptSha256: string;
  state: "opened";
  disposition: "succeeded";
  sourceBranch: string;
  targetBranch: string;
  commitRevision: string;
  mergeRequest: { iid: number; url: string; draft: true; headRevision: string };
}

/** Typed adapter failure when terminal publication evidence fails its binding. */
export class PublicationResultContractError extends Error {
  public readonly code = "publication-result-mismatch";

  public constructor() {
    super("The draft-MR result did not match the target branch and URL retained for this run.");
    this.name = "PublicationResultContractError";
  }
}

/** Shared closed decoder for production, live acceptance, and offline acceptance. */
export function decodeLocalUserGitLabPublicationResult(
  value: unknown,
): LocalUserGitLabPublicationResultV1 {
  const root = exactObject(value, [
    "schemaVersion",
    "kind",
    "status",
    "planSha256",
    "idempotencyKey",
    "receiptSha256",
    "state",
    "disposition",
    "sourceBranch",
    "targetBranch",
    "commitRevision",
    "mergeRequest",
  ]);
  const mergeRequest = exactObject(root.mergeRequest, ["iid", "url", "draft", "headRevision"]);
  if (
    root.schemaVersion !== 1 ||
    root.kind !== "docsfab-local-user-gitlab-publication-result" ||
    root.status !== "opened" ||
    !isSha(root.planSha256) ||
    !isSha(root.idempotencyKey) ||
    !isSha(root.receiptSha256) ||
    root.state !== "opened" ||
    root.disposition !== "succeeded" ||
    typeof root.sourceBranch !== "string" ||
    !SAFE_BRANCH.test(root.sourceBranch) ||
    typeof root.targetBranch !== "string" ||
    !SAFE_BRANCH.test(root.targetBranch) ||
    root.sourceBranch === root.targetBranch ||
    !isRevision(root.commitRevision) ||
    !Number.isSafeInteger(mergeRequest.iid) ||
    (mergeRequest.iid as number) <= 0 ||
    typeof mergeRequest.url !== "string" ||
    mergeRequest.url.length > 2048 ||
    mergeRequest.draft !== true ||
    mergeRequest.headRevision !== root.commitRevision
  ) {
    throw new Error("Publication result did not contain exact terminal draft-MR evidence.");
  }
  return value as LocalUserGitLabPublicationResultV1;
}

function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== [...keys].sort().join(",")
  ) {
    throw new Error("Publication result is invalid.");
  }
  return value as Record<string, unknown>;
}

function isSha(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}

function isRevision(value: unknown): value is string {
  return typeof value === "string" && REVISION.test(value);
}
