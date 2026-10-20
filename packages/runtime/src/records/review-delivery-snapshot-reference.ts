// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** A saved review run's unique pointer to its private, checked source graph. */
import { createContractKit } from "../contract-kit/index.js";
import type { RunChangeSourceV1 } from "./change-sources.js";

export interface ReviewDeliverySnapshotReferenceV1 {
  readonly kind: "docsfab-review-delivery-snapshot-reference";
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly rootObjectSha256: string;
  readonly snapshotSha256: string;
  readonly changeSourceSha256: string;
  readonly reviewedHeadSha: string;
  readonly repositoryIdentitySha256: string;
}

export interface ReviewDeliverySnapshotReferenceContext {
  readonly runId: string;
  readonly workflow: string;
  readonly status: string;
  /** The enclosing strict run reader already decodes these sealed citations. */
  readonly changeSources?: readonly Pick<
    RunChangeSourceV1,
    "changeSourceSha256" | "repository" | "head"
  >[];
}

export class ReviewDeliverySnapshotReferenceError extends Error {
  public constructor() {
    super("The saved review source snapshot reference is invalid for this successful run.");
    this.name = "ReviewDeliverySnapshotReferenceError";
  }
}

const fail = (): never => {
  throw new ReviewDeliverySnapshotReferenceError();
};

const kit = createContractKit<"invalid">({
  fail,
  inertMode: "strict",
  codes: {
    invalidShape: "invalid",
    invalidValue: "invalid",
    digestMismatch: "invalid",
    credentialMaterial: "invalid",
    schemaMismatch: "invalid",
  },
});

/** Decode the pointer only beside the successful run and its one matching source citation. */
export function decodeReviewDeliverySnapshotReference(
  value: unknown,
  context: ReviewDeliverySnapshotReferenceContext,
): ReviewDeliverySnapshotReferenceV1 {
  kit.assertInert(value);
  const root = kit.object(value);
  kit.exact(root, [
    "kind",
    "schemaVersion",
    "runId",
    "rootObjectSha256",
    "snapshotSha256",
    "changeSourceSha256",
    "reviewedHeadSha",
    "repositoryIdentitySha256",
  ]);
  if (
    root.kind !== "docsfab-review-delivery-snapshot-reference" ||
    root.schemaVersion !== 1 ||
    context.workflow !== "review-documentation" ||
    context.status !== "succeeded"
  )
    fail();
  const result: ReviewDeliverySnapshotReferenceV1 = {
    kind: "docsfab-review-delivery-snapshot-reference",
    schemaVersion: 1,
    runId: kit.identifier(root.runId),
    rootObjectSha256: kit.hash(root.rootObjectSha256),
    snapshotSha256: kit.hash(root.snapshotSha256),
    changeSourceSha256: kit.hash(root.changeSourceSha256),
    reviewedHeadSha: kit.revision(root.reviewedHeadSha),
    repositoryIdentitySha256: kit.hash(root.repositoryIdentitySha256),
  };
  const matches = context.changeSources?.filter(
    (source) => source.changeSourceSha256 === result.changeSourceSha256,
  );
  if (
    result.runId !== context.runId ||
    matches?.length !== 1 ||
    matches[0]?.head !== result.reviewedHeadSha ||
    matches[0]?.repository.identitySha256 !== result.repositoryIdentitySha256
  )
    fail();
  return result;
}
