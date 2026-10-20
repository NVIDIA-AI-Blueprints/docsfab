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

export interface ReviewGitLabSuggestionPositionV1 {
  readonly base_sha: string;
  readonly start_sha: string;
  readonly head_sha: string;
  readonly position_type: "text";
  readonly old_path: string | null;
  readonly new_path: string;
  readonly new_line: number;
}

/** Pure codec; this function cannot create a discussion or apply a suggestion. */
export function compileGitLabSuggestionV1(
  proposal: ReviewSuggestionProposalV1,
  nativePosition: ReviewGitLabSuggestionPositionV1,
  profile: ReviewSuggestionProfileV1,
): ReviewSuggestionCodecResultV1<ReviewGitLabSuggestionPositionV1> {
  const refuse = (reason: "provider-capability-unqualified" | "after-location-unavailable") =>
    deepFreeze({ kind: "unsupported" as const, reason, retained: proposal.retained });
  const target = proposal.binding.target;
  if (
    profile.provider !== "gitlab" ||
    target.scmProvider !== "gitlab" ||
    !profile.gitlabOffsets ||
    !Number.isSafeInteger(profile.gitlabOffsets.before) ||
    profile.gitlabOffsets.before < 0 ||
    !Number.isSafeInteger(profile.gitlabOffsets.after) ||
    profile.gitlabOffsets.after < 0
  )
    return refuse("provider-capability-unqualified");
  const expected: ReviewGitLabSuggestionPositionV1 = {
    base_sha: target.baseSha,
    start_sha: proposal.binding.startSha ?? "",
    head_sha: proposal.binding.reviewedHeadSha,
    position_type: "text",
    old_path: proposal.anchor.oldPath,
    new_path: proposal.path,
    new_line: proposal.anchor.endLine,
  };
  if (proposal.anchor.side !== "after" || canonicalJson(nativePosition) !== canonicalJson(expected))
    return refuse("after-location-unavailable");
  const before = nativePosition.new_line - proposal.anchor.startLine;
  const after = proposal.anchor.endLine - nativePosition.new_line;
  if (before > profile.gitlabOffsets.before || after > profile.gitlabOffsets.after)
    return refuse("provider-capability-unqualified");
  const rendered = reviewSuggestionBodyV1(proposal, profile, `suggestion:-${before}+${after}`);
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
