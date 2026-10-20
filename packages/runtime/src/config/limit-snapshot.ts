// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Effective rich-result field bounds installed by supported limit activation.
 * This leaf cannot import limits.ts: the loader reaches review contracts while
 * resolving configuration, and review contracts must read these bounds.
 */

import { LIMIT_DEFINITION_BY_NAME } from "./limits.generated.js";

export const REVIEW_RICH_FIELD_LIMITS = [
  "technicalCorrection.fieldMaxChars",
  "technicalCorrection.proseMaxChars",
] as const;

export type ReviewRichFieldLimitName = (typeof REVIEW_RICH_FIELD_LIMITS)[number];

export type ReviewRichFieldLimitSnapshot = Readonly<Record<ReviewRichFieldLimitName, number>>;

function catalogValue(name: ReviewRichFieldLimitName): number {
  const definition = LIMIT_DEFINITION_BY_NAME[name];
  if (!definition) {
    throw new Error(
      `Rich-result operational limit ${name} is missing from the generated config/limits.yaml catalog.`,
    );
  }
  return definition.value;
}

let effective: ReviewRichFieldLimitSnapshot = Object.freeze({
  "technicalCorrection.fieldMaxChars": catalogValue("technicalCorrection.fieldMaxChars"),
  "technicalCorrection.proseMaxChars": catalogValue("technicalCorrection.proseMaxChars"),
});

export function reviewRichFieldLimit(name: ReviewRichFieldLimitName): number {
  return effective[name];
}

/** Publish values already validated by resolveLimits, as one immutable snapshot. */
export function installReviewRichFieldLimitSnapshot(snapshot: ReviewRichFieldLimitSnapshot): void {
  effective = Object.freeze({
    "technicalCorrection.fieldMaxChars": snapshot["technicalCorrection.fieldMaxChars"],
    "technicalCorrection.proseMaxChars": snapshot["technicalCorrection.proseMaxChars"],
  });
}
