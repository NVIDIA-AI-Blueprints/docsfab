// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Retry rule hint for the code `findContractPlaceholder` raises when a reply
 * repeats a host contract placeholder. The text is host-authored and never
 * includes response content; see `rejection-rule-hints.ts`. Change the hint
 * with the rule it explains.
 */

import { CONTRACT_PLACEHOLDER_REJECTION_CODE } from "./contract-placeholders.js";
import type { RejectionRuleHint } from "./rejection-rule-hints.js";

export const CONTRACT_PLACEHOLDER_RULE =
  "A value at this location repeats an example from the host response contract instead of stating what this run found. An angle-bracketed description, such as one naming a limitation code or a source locator, only says what belongs there: replace it with the actual value the evidence supports. Never copy an example value, and omit an optional entry, such as a limitation, that the evidence does not establish.";

export const CONTRACT_PLACEHOLDER_RULE_HINTS: Readonly<
  Record<typeof CONTRACT_PLACEHOLDER_REJECTION_CODE, RejectionRuleHint>
> = Object.freeze({
  [CONTRACT_PLACEHOLDER_REJECTION_CODE]: Object.freeze({
    rule: CONTRACT_PLACEHOLDER_RULE,
  }),
});
