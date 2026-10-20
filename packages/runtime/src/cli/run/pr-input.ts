// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { GithubPullRequestSelectorV1 } from "../../inputs/change-source/github-url.js";

/** Fixed operator refusals before public PR acquisition. */
export class GithubPrReviewCliError extends Error {
  constructor(
    readonly code:
      | "workflow-required"
      | "option-conflict"
      | "selector-conflict"
      | "checkout-conflict"
      | "basis-mismatch",
    option?: string,
  ) {
    super(
      code === "workflow-required"
        ? "A GitHub --pr review requires review-documentation. Select that workflow, then run again."
        : code === "option-conflict"
          ? `GitHub PR review cannot combine --pr with ${option}. Remove ${option}, then run again.`
          : code === "selector-conflict"
            ? "GitHub PR review requires --pr; --mr selects GitLab. Use one selector, then run again."
            : code === "checkout-conflict"
              ? "The selected GitHub PR cannot enter a checkout-bound or resumed review. Remove the conflicting input, then run again."
              : "The acquired GitHub PR basis differs from its H review workspace. Refresh the PR selection, then run again.",
    );
    this.name = "GithubPrReviewCliError";
  }
}

export function failGithubPrReviewCli(
  code: ConstructorParameters<typeof GithubPrReviewCliError>[0],
  option?: string,
): never {
  throw new GithubPrReviewCliError(code, option);
}

/** A parsed public PR selection. Acquisition alone may turn it into a review basis. */
export interface GithubPrReviewInputV1 {
  readonly kind: "github-pr-review-input";
  readonly url: string;
  readonly selector: GithubPullRequestSelectorV1;
}

const CONFLICTING_VALUE_OPTIONS = [
  "--repo",
  "--revision",
  "--remote",
  "--comment-mr",
  "--resume-from",
  "--change",
  "--review-target",
  "--rescope-from",
] as const;
const CONFLICTING_FLAGS = ["--draft-mr", "--allow-write", "--patch-only"] as const;

/** Admission runs on original argv, before any workspace, forge, or model call. */
export function admitGithubPrReviewInput(input: {
  readonly workflow: string;
  readonly args: readonly string[];
  readonly url: string;
  readonly selector: GithubPullRequestSelectorV1;
}): GithubPrReviewInputV1 {
  if (input.workflow !== "review-documentation") {
    failGithubPrReviewCli("workflow-required");
  }
  for (const flag of CONFLICTING_FLAGS) {
    if (input.args.includes(flag)) {
      failGithubPrReviewCli("option-conflict", flag);
    }
  }
  for (const name of CONFLICTING_VALUE_OPTIONS) {
    if (input.args.some((arg) => arg === name || arg.startsWith(`${name}=`))) {
      failGithubPrReviewCli("option-conflict", name);
    }
  }
  if (input.args.some((arg) => arg === "--mr" || arg.startsWith("--mr="))) {
    failGithubPrReviewCli("selector-conflict");
  }
  return Object.freeze({
    kind: "github-pr-review-input",
    url: input.url,
    selector: input.selector,
  });
}
