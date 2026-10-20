// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { decodeReviewDeliverySnapshotReference } from "../src/records/review-delivery-snapshot-reference.js";

const sha = (letter: string) => letter.repeat(64);
const head = "c".repeat(40);
const source = {
  changeSourceSha256: sha("a"),
  repository: { kind: "local-checkout" as const, identitySha256: sha("b") },
  head,
  observations: [
    { role: "manifest", observationId: "manifest-1" },
    { role: "diff", observationId: "diff-1" },
  ],
};
const context = {
  runId: "saved-review",
  workflow: "review-documentation",
  status: "succeeded",
  changeSources: [source],
};
const reference = {
  kind: "docsfab-review-delivery-snapshot-reference",
  schemaVersion: 1,
  runId: context.runId,
  rootObjectSha256: sha("d"),
  snapshotSha256: sha("e"),
  changeSourceSha256: source.changeSourceSha256,
  reviewedHeadSha: head,
  repositoryIdentitySha256: source.repository.identitySha256,
};

describe("saved review source snapshot reference", () => {
  it("admits only one closed reference matching the successful review run and its sealed citation", () => {
    expect(decodeReviewDeliverySnapshotReference(reference, context)).toEqual(reference);
    expect(() =>
      decodeReviewDeliverySnapshotReference({ ...reference, extra: true }, context),
    ).toThrow();
    expect(() =>
      decodeReviewDeliverySnapshotReference(reference, {
        ...context,
        changeSources: [source, source],
      }),
    ).toThrow();
  });

  it.each([
    { field: "runId", value: "another-run" },
    { field: "rootObjectSha256", value: "not-a-digest" },
    { field: "snapshotSha256", value: sha("f") },
    { field: "changeSourceSha256", value: sha("f") },
    { field: "reviewedHeadSha", value: "f".repeat(40) },
    { field: "repositoryIdentitySha256", value: sha("f") },
  ])("refuses a foreign or malformed $field", ({ field, value }) => {
    const changed = { ...reference, [field]: value };
    if (field === "snapshotSha256") {
      // A digest is an identity, not derivable from the run citation alone.
      expect(decodeReviewDeliverySnapshotReference(changed, context)).toEqual(changed);
    } else {
      expect(() => decodeReviewDeliverySnapshotReference(changed, context)).toThrow();
    }
  });

  it("refuses a failed run or a write workflow even with a self-consistent reference", () => {
    expect(() =>
      decodeReviewDeliverySnapshotReference(reference, { ...context, status: "failed" }),
    ).toThrow();
    expect(() =>
      decodeReviewDeliverySnapshotReference(reference, {
        ...context,
        workflow: "create-documentation",
      }),
    ).toThrow();
  });
});
