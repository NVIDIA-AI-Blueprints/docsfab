// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Independently authored paths; no private path or filename is transformed. */
export function publicReviewTargetScope() {
  const documentationTargets = Array.from({ length: 1_312 }, (_, index) => {
    // Long leading paths make the host's count suffix cross its former field
    // bound; the tail keeps the whole independently authored scope at 99,404
    // path characters and the same 434,239-byte host-coverage floor.
    const length = index < 64 ? 102 : index - 64 < 524 ? 75 : 74;
    const stem = `docs/public-synthetic/section-${String(index).padStart(4, "0")}-`;
    return `${stem}${"p".repeat(length - stem.length - ".md".length)}.md`;
  });
  return {
    label: "public independently authored target list",
    documentationTargets,
    targetDescription: "1,313 independently authored synthetic targets",
    judgmentProposalBytes: 470_958,
    floorProposalBytes: 471_286,
  };
}
