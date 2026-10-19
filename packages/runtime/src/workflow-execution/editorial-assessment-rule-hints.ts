// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Retry rule hints for `decodeEditorialAssessmentProposalV1`, one per code in
 * `EDITORIAL_LIMITATION_CODE_REJECTIONS`. The text is host-authored and never
 * includes response content; see `rejection-rule-hints.ts`. Change a hint with
 * the rule it explains.
 */

import type { EDITORIAL_LIMITATION_CODE_REJECTIONS } from "./editorial-evidence-host.js";
import type { RejectionRuleHint } from "./rejection-rule-hints.js";

type EditorialLimitationCodeRejection =
  (typeof EDITORIAL_LIMITATION_CODE_REJECTIONS)[keyof typeof EDITORIAL_LIMITATION_CODE_REJECTIONS];

/** The rule for a limitation or recommendation code outside the outcome code grammar. */
export const EDITORIAL_LIMITATION_CODE_RULE =
  "Every limitation and recommendation code must use only lowercase letters, digits, dots, and hyphens, and start with a letter or digit. Underscores, slashes, spaces, and uppercase letters are refused: write a hyphen wherever you wrote an underscore, and lowercase every letter.";

export const EDITORIAL_ASSESSMENT_RULE_HINTS: Readonly<
  Record<EditorialLimitationCodeRejection["code"], RejectionRuleHint>
> = Object.freeze({
  "editorial-limitation-code-off-grammar": Object.freeze({
    rule: EDITORIAL_LIMITATION_CODE_RULE,
  }),
});
