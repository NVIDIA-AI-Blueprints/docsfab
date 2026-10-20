// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The failure class of each model-output catalog code. It resolves no
 * operational limit, unlike `model-output.ts`, which renders limit values when
 * it loads, so the operator error reporter can load it even when the limits
 * configuration is the failure being reported.
 */

import type { FailureClass } from "../operator/failure-class.js";
import {
  OUTPUT_RULE_ALIASES,
  OUTPUT_RULES,
  type OutputRuleDeclaration,
} from "./model-output.generated.js";

type RuleTable = Readonly<Record<string, OutputRuleDeclaration>>;

/**
 * The failure class of every recorded catalog code, and of each earlier
 * spelling a code still decodes as.
 */
export const OUTPUT_RULE_FAILURE_CLASSES: Readonly<Record<string, FailureClass>> = Object.freeze(
  Object.fromEntries([
    ...Object.values(OUTPUT_RULES as RuleTable).map((rule) => [rule.code, rule.failureClass]),
    ...Object.entries(OUTPUT_RULE_ALIASES as Readonly<Record<string, string>>).map(
      ([alias, code]) => [alias, (OUTPUT_RULES as RuleTable)[code]!.failureClass],
    ),
  ]),
);
