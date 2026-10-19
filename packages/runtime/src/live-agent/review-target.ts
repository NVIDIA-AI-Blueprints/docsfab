// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Bind an operator-named PR to the same immutable files and change evidence. */
import { runTrustedGit } from "../host-invoker/trusted-git.js";
import { resolveGithubChangeSource } from "../inputs/change-source/github.js";
import {
  parseChangeSourceSelector,
  type ChangeSourceMemberV1,
  type ResolvedChangeSourceV1,
} from "../inputs/change-source.js";
import type { GithubPullRequestSelectorV1 } from "../inputs/change-source/github-url.js";

export interface LiveReviewTarget {
  readonly revision: string;
  readonly changeSource: GithubPullRequestSelectorV1;
  readonly preparedReviewChange: ResolvedChangeSourceV1<ChangeSourceMemberV1>;
}

export const LIVE_REVIEW_TARGET_FAILURES = {
  "live-review-target-ambiguous":
    "Review target is ambiguous (live-review-target-ambiguous). Name one PR to review in this request.",
  "live-review-target-invalid":
    "Review target is invalid (live-review-target-invalid). Use the whole GitHub pull request URL.",
  "live-review-snapshot-unavailable":
    "PR snapshot is unavailable (live-review-snapshot-unavailable). Fetch the PR head through the terminal-approved bash tool in a write-enabled session, then retry the review workflow. Keep the checkout on its current branch.",
  "live-review-retry-source-unavailable":
    "The saved PR review needs its original source (live-review-retry-source-unavailable). Select the original PR with /sources review <PR URL>, then retry.",
  "live-review-retry-evidence-moved":
    "The PR evidence differs from the saved review (live-review-retry-evidence-moved). Start a new review request to review the current PR snapshot and diff.",
  "live-review-retry-network-disabled":
    "The saved PR review requires network access to verify its original evidence (live-review-retry-network-disabled). Start a new local-evidence review request to continue without network access.",
} as const;

export class LiveReviewTargetError extends Error {
  constructor(readonly code: keyof typeof LIVE_REVIEW_TARGET_FAILURES) {
    super(LIVE_REVIEW_TARGET_FAILURES[code]);
    this.name = "LiveReviewTargetError";
  }
}

/** Reads only the bound operator request, never retrieved or conversational context. */
export function liveReviewPullRequest(
  instruction: string,
): GithubPullRequestSelectorV1 | undefined {
  const urls = [...instruction.matchAll(/https?:\/\/(?:www\.)?github\.com\/[^\s<>"`]+/gu)]
    .map(([url]) => url.replace(/[),.;\]]+$/u, ""))
    .filter((url) => /\/pull\//u.test(url));
  const distinct = [...new Set(urls)];
  if (distinct.length === 0) return undefined;
  if (distinct.length !== 1) {
    // hygiene: ok -- the typed code selects a fixed operator diagnostic.
    throw new LiveReviewTargetError("live-review-target-ambiguous");
  }
  const selector = parseChangeSourceSelector(distinct[0]!);
  if (selector.source !== "github-pull-request") {
    // hygiene: ok -- the typed code selects a fixed operator diagnostic.
    throw new LiveReviewTargetError("live-review-target-invalid");
  }
  return selector;
}

export async function prepareLiveReviewTarget(input: {
  instruction: string;
  repositoryPath: string;
  /** A validated source selected by the operator, including through --pr. */
  changeSource?: GithubPullRequestSelectorV1;
  /** Host-recovered evidence identity for a saved PR review; never model supplied. */
  expectedRetry?: { readonly revision: string; readonly changeSourceSha256: string };
  signal?: AbortSignal;
  onNotice?: (message: string) => void;
}): Promise<LiveReviewTarget | undefined> {
  const namedChange = liveReviewPullRequest(input.instruction);
  if (
    namedChange &&
    input.changeSource &&
    (namedChange.number !== input.changeSource.number ||
      namedChange.owner.toLowerCase() !== input.changeSource.owner.toLowerCase() ||
      namedChange.repository.toLowerCase() !== input.changeSource.repository.toLowerCase())
  ) {
    // hygiene: ok -- the typed code selects a fixed operator diagnostic.
    throw new LiveReviewTargetError("live-review-target-ambiguous");
  }
  const changeSource = namedChange ?? input.changeSource;
  if (!changeSource) {
    if (input.expectedRetry) {
      // hygiene: ok -- the typed code selects a fixed operator diagnostic.
      throw new LiveReviewTargetError("live-review-retry-source-unavailable");
    }
    return undefined;
  }
  if (!liveReviewNetworkAllowed(input.instruction)) {
    if (input.expectedRetry) {
      // hygiene: ok -- the typed code selects a fixed operator diagnostic.
      throw new LiveReviewTargetError("live-review-retry-network-disabled");
    }
    input.onNotice?.(
      "Local-evidence review: the request disables network access, so no GitHub PR snapshot or diff is acquired. The workflow uses the supplied local evidence.",
    );
    return undefined;
  }
  const preparedReviewChange = await resolveGithubChangeSource({
    selector: changeSource,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const revision = preparedReviewChange.changeSource.revision.head;
  if (
    input.expectedRetry &&
    (revision !== input.expectedRetry.revision ||
      preparedReviewChange.changeSource.changeSourceSha256 !==
        input.expectedRetry.changeSourceSha256)
  ) {
    // hygiene: ok -- the typed code selects a fixed operator diagnostic.
    throw new LiveReviewTargetError("live-review-retry-evidence-moved");
  }
  try {
    await runTrustedGit(
      input.repositoryPath,
      ["cat-file", "-e", `${revision}^{commit}`],
      input.signal,
    );
  } catch (error) {
    if (input.signal?.aborted) throw error;
    // hygiene: ok -- the typed code selects a fixed operator diagnostic.
    throw new LiveReviewTargetError("live-review-snapshot-unavailable");
  }
  input.onNotice?.(
    `Review target: GitHub PR #${changeSource.number}, commit ${revision}. The workflow uses that snapshot and its bound PR diff; the current checkout stays in place.`,
  );
  return { revision, changeSource, preparedReviewChange };
}

export function liveReviewNetworkAllowed(instruction: string): boolean {
  return !/\b(?:no (?:network|internet)|without (?:accessing|using) (?:the )?(?:network|internet)|(?:do not|don['’]?t) (?:access|use|contact) (?:the )?(?:network|internet|github))\b/iu.test(
    instruction,
  );
}
