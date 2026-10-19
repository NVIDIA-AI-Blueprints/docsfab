// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Fixed operator-facing refusals for the explicit CLI review-delivery route. */
const MESSAGES = {
  "duplicate-option": "Review delivery mode and target must each be supplied once.",
  "missing-pair": "Review delivery requires both --review-delivery and --review-delivery-target.",
  "explicit-source-required":
    "Review delivery requires review-documentation and one explicit --change or --mr source.",
  "invalid-mode": "Unknown review delivery mode. Choose preview; publish is not yet supported.",
  "publish-unsupported":
    "Review delivery publish is not yet supported on this CLI route; use --review-delivery preview.",
  "target-url-required":
    "--review-delivery-target requires one full HTTPS GitLab merge-request URL.",
  "read-only-required":
    "Review delivery preview requires a read-only run without another delivery mode.",
  "source-binding-mismatch":
    "Review delivery source binding differs from the acquired run repository. Refresh the checkout and rerun the preview at the selected head.",
  "target-source-mismatch":
    "Review delivery target must equal the selected GitLab change source. Select the same merge request for --change and --review-delivery-target.",
  "target-stale":
    "Review delivery target no longer matches the acquired MR head and project. Refresh the checkout and rerun the preview.",
  "acquired-change-required":
    "Review delivery preview requires one acquired GitLab change and an unused review retention port.",
  "result-artifact-unavailable":
    "Review delivery original result artifact is unavailable. Inspect the retained run artifacts before retrying the preview.",
} as const;

export type ReviewDeliveryCliErrorCode = keyof typeof MESSAGES;

export class ReviewDeliveryCliOperatorError extends Error {
  public constructor(public readonly code: ReviewDeliveryCliErrorCode) {
    super(MESSAGES[code]);
    this.name = "ReviewDeliveryCliOperatorError";
  }
}
