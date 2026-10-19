// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Narrow live-agent adapter for the released shared change-source review path. */
import { parseChangeSourceSelector, type ChangeSourceSelectorV1 } from "../inputs/change-source.js";
import type { RunRecord } from "../records/contracts/run-records.js";

export type LiveAgentChangeReviewSelectorV1 =
  | Extract<ChangeSourceSelectorV1, { readonly source: "github-pull-request" }>
  | Extract<ChangeSourceSelectorV1, { readonly source: "gitlab-merge-request" }>;

export interface LiveAgentChangeReviewSelectionV1 {
  readonly reference: string;
  readonly label: string;
  readonly provider: "github" | "gitlab";
  readonly status: "selected";
  readonly sourceRead: "not-read";
}

export function liveAgentChangeReviewSelection(
  selector: LiveAgentChangeReviewSelectorV1,
): LiveAgentChangeReviewSelectionV1 {
  const github = selector.source === "github-pull-request";
  const reference = github
    ? `https://github.com/${selector.owner}/${selector.repository}/pull/${selector.number}`
    : `${selector.changeRequest.host}/${selector.changeRequest.projectPath}!${selector.changeRequest.number}`;
  const label = github
    ? `${selector.owner}/${selector.repository}#${selector.number}`
    : `${selector.changeRequest.host}/${selector.changeRequest.projectPath}!${selector.changeRequest.number}`;
  return Object.freeze({
    reference,
    label,
    provider: github ? "github" : "gitlab",
    status: "selected",
    sourceRead: "not-read",
  });
}

export interface LiveAgentChangeReviewRequestV1 {
  readonly workflow: "review-documentation";
  readonly instruction: string;
  readonly changeSource: LiveAgentChangeReviewSelectorV1;
}

/** The host supplies the existing bounded runner; the bridge has no fetch or shell port. */
export type LiveAgentChangeReviewInvokerV1 = (
  request: LiveAgentChangeReviewRequestV1,
) => Promise<RunRecord>;

export type LiveAgentChangeReviewReferenceErrorCode = "invalid-reference" | "unsupported-reference";

const REFERENCE_REFUSALS: Readonly<Record<LiveAgentChangeReviewReferenceErrorCode, string>> =
  Object.freeze({
    "invalid-reference":
      "That is not a supported pull or merge request reference. Pass a GitHub pull-request URL or a configured GitLab merge-request URL or host/group/project!number reference.",
    "unsupported-reference":
      "That change reference does not name a pull or merge request. Pass a GitHub pull-request URL or a configured GitLab merge-request URL or host/group/project!number reference.",
  });

export class LiveAgentChangeReviewReferenceError extends Error {
  public constructor(public readonly code: LiveAgentChangeReviewReferenceErrorCode) {
    super(REFERENCE_REFUSALS[code]);
    this.name = "LiveAgentChangeReviewReferenceError";
  }
}

function invalidReferenceError(
  code: LiveAgentChangeReviewReferenceErrorCode,
): LiveAgentChangeReviewReferenceError {
  return new LiveAgentChangeReviewReferenceError(code);
}

/**
 * Parse through the canonical source selector grammar, admitting only whole
 * GitHub PRs and configured GitLab MRs. This is validation only: it resolves
 * no identity, reads no source, and never substitutes the local revision.
 */
export function parseLiveAgentChangeReviewReference(
  value: string,
): LiveAgentChangeReviewSelectorV1 {
  let selector: ChangeSourceSelectorV1;
  try {
    selector = parseChangeSourceSelector(value);
  } catch {
    throw invalidReferenceError("invalid-reference");
  }
  if (selector.source === "github-pull-request" || selector.source === "gitlab-merge-request") {
    return selector;
  }
  throw invalidReferenceError("unsupported-reference");
}

/** Run the shared documentation review against the operator-selected change. */
export async function invokeLiveAgentChangeReview(input: {
  readonly reference: string;
  readonly instruction: string;
  readonly invoke: LiveAgentChangeReviewInvokerV1;
}): Promise<RunRecord> {
  const request: LiveAgentChangeReviewRequestV1 = Object.freeze({
    workflow: "review-documentation",
    instruction: input.instruction,
    changeSource: parseLiveAgentChangeReviewReference(input.reference),
  });
  return input.invoke(request);
}
