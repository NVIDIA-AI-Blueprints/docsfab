// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { canonicalDigest, canonicalJson, sha256 } from "../../content-ir/canonical.js";
import { deepFreeze } from "../../contract-kit/index.js";
import { reviewSuggestionBodyV1 } from "../suggestions.js";
import type {
  ReviewSuggestionCodecResultV1,
  ReviewSuggestionProfileV1,
  ReviewSuggestionProposalV1,
} from "../suggestions.js";

export interface ReviewGitHubSuggestionPositionV1 {
  readonly commit_id: string;
  readonly path: string;
  readonly line: number;
  readonly side: "RIGHT";
  readonly start_line?: number;
  readonly start_side?: "RIGHT";
}

/** Fragment for D4's existing single pending review batch; no transport/lifecycle. */
export function compileGitHubSuggestionV1(
  proposal: ReviewSuggestionProposalV1,
  nativePosition: ReviewGitHubSuggestionPositionV1,
  profile: ReviewSuggestionProfileV1,
): ReviewSuggestionCodecResultV1<ReviewGitHubSuggestionPositionV1> {
  if (profile.provider !== "github" || proposal.binding.target.scmProvider !== "github")
    return deepFreeze({
      kind: "unsupported",
      reason: "provider-capability-unqualified",
      retained: proposal.retained,
    });
  const expected: ReviewGitHubSuggestionPositionV1 = {
    commit_id: proposal.binding.reviewedHeadSha,
    path: proposal.path,
    line: proposal.anchor.endLine,
    side: "RIGHT",
    ...(proposal.anchor.startLine === proposal.anchor.endLine
      ? {}
      : {
          start_line: proposal.anchor.startLine,
          start_side: "RIGHT" as const,
        }),
  };
  if (proposal.anchor.side !== "after" || canonicalJson(nativePosition) !== canonicalJson(expected))
    return deepFreeze({
      kind: "unsupported",
      reason: "after-location-unavailable",
      retained: proposal.retained,
    });
  const rendered = reviewSuggestionBodyV1(proposal, profile, "suggestion");
  if ("reason" in rendered)
    return deepFreeze({
      kind: "unsupported",
      reason: rendered.reason,
      retained: proposal.retained,
    });
  return deepFreeze({
    kind: "offline-fragment",
    proof: "offline-codec-only",
    body: rendered.body,
    bodySha256: sha256(rendered.body),
    payloadSha256: proposal.payloadSha256,
    coordinates: structuredClone(nativePosition),
    coordinatesSha256: canonicalDigest(nativePosition),
  });
}
