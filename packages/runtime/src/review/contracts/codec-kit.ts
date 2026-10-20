// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createContractKit, type ContractFail } from "../../contract-kit/index.js";

export type ReviewTargetErrorCode =
  | "invalid-shape"
  | "invalid-value"
  | "digest-mismatch"
  | "credential-material"
  // Nothing raises this code; it stays so a saved rejection still classifies.
  | "host-path"
  | "unsupported-intent"
  | "unknown-target"
  | "ambiguous-target"
  | "moving-target"
  | "mr-head-changed"
  | "incomplete-proof"
  | "authority-required"
  | "migration-required";

export class ReviewTargetError extends Error {
  public constructor(public readonly code: ReviewTargetErrorCode) {
    super(`Review-target contract rejected: ${code}.`);
    this.name = "ReviewTargetError";
  }
}

export function failReviewTarget(code: ReviewTargetErrorCode): never {
  throw new ReviewTargetError(code);
}

const kit = createContractKit({
  fail: failReviewTarget as ContractFail<ReviewTargetErrorCode>,
  inertMode: "strict",
  codes: {
    invalidShape: "invalid-shape",
    invalidValue: "invalid-value",
    digestMismatch: "digest-mismatch",
    credentialMaterial: "credential-material",
    schemaMismatch: "migration-required",
  },
});
export { kit };

export const REVIEW_FINDING_SEVERITIES = ["info", "warning", "error"] as const;
