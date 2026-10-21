// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  assertGithubPrReviewBasis,
  type GithubPrReviewBasis,
} from "../inputs/adapters/github-pr-provider.js";
import type { RepositoryWorkspace } from "../repository/workspace/contracts.js";

/** This capability is process-local; a copied shape has no check authority. */
export interface PrReviewCheckAdmissionV1 {
  readonly kind: "docsfab-pr-review-check-admission";
  readonly mode: "inventory-only";
}

const minted = new WeakMap<object, GithubPrReviewBasis>();

export function createPrReviewCheckAdmission(basis: GithubPrReviewBasis): PrReviewCheckAdmissionV1 {
  assertGithubPrReviewBasis(basis);
  const admission: PrReviewCheckAdmissionV1 = Object.freeze({
    kind: "docsfab-pr-review-check-admission",
    mode: "inventory-only",
  });
  minted.set(admission, basis);
  return admission;
}

export function assertPrReviewCheckAdmission(
  admission: PrReviewCheckAdmissionV1,
  workspace: RepositoryWorkspace,
): void {
  const basis = minted.get(admission);
  if (!basis || admission.mode !== "inventory-only") {
    throw new Error("PR review check admission requires a live host capability.");
  }
  assertGithubPrReviewBasis(basis);
  if (workspace !== basis.headWorkspace) {
    throw new Error("PR review check admission is bound to the acquired H workspace.");
  }
}
