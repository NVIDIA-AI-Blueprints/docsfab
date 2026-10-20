// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Runtime reader of the model-output rule catalog.
 *
 * `config/model-output/` declares every rule the host enforces on model
 * output once; `scripts/check-model-output.mjs` renders it into
 * `model-output.generated.ts`. This module derives what the runtime consumes
 * from that one table, so the model, the validator, the retry decision, the
 * failure report, and the operator read the same facts:
 *
 * - the contract text a binder appends to a step prompt
 *   (`renderResponseContract`), built from each rule's `statement`;
 * - the retry hint for each model-correctable rule (`outputRuleHintCatalog`),
 *   the same `statement` closed by its family's replay-mode statement;
 * - the retry disposition (`isModelCorrectableOutputRule`) and the failure
 *   class of each code (`OUTPUT_RULE_FAILURE_CLASSES`, re-exported from
 *   `model-output-failure-classes.ts`, which loads without resolving limits).
 *
 * Rule predicates stay in their owning validators. They name a rule only
 * through `rejectOutput`, `rejectCorrectable`, or `rejectTerminal`, so an
 * undeclared code or location does not compile, and a security or authority
 * predicate that raises through `rejectTerminal` cannot name a correctable code.
 *
 * Every rendered sentence is host-authored catalog text. The only substituted
 * values are `{limit:<name>}` (the effective limit value) and
 * `{grammar:<id>}` (the grammar's own statement), and the host blocks a
 * binder supplies from sealed host input. Nothing here repeats model text.
 */

import { OUTPUT_RULES, outputRuleFor } from "./model-output.generated.js";
import {
  catalogTables,
  renderOutputText,
  type OutputCatalogTables,
} from "./model-output-render.js";

export * from "./model-output.generated.js";
export {
  renderOutputText,
  renderResponseContract,
  type OutputCatalogTables,
} from "./model-output-render.js";

/** One retry hint, in the `RejectionRuleHint` shape `rejection-rule-hints.ts` reads. */
export interface OutputRuleHint {
  readonly rule: string;
  readonly atLocation?: Readonly<Record<string, string>>;
}

/**
 * The retry hint of every model-correctable rule, keyed by recorded code. The
 * hint is the rule's `statement` (or its `atLocation` sentence), closed by the
 * replay-mode statement its family declares, such as the candidate-0 restore
 * of a `reset-write-step` writer. A terminal rule is never re-asked, and the
 * catch-all has no statement, so neither has an entry here.
 */
export function outputRuleHintCatalog(
  tables: OutputCatalogTables = catalogTables(),
): Readonly<Record<string, OutputRuleHint>> {
  const catalog: Record<string, OutputRuleHint> = {};
  for (const rule of Object.values(tables.rules)) {
    if (rule.retry !== "model-correctable" || rule.statement === null) continue;
    const replay = tables.families[rule.family]?.replay;
    const suffix = replay ? tables.replayModes[replay].statement : null;
    const close = (text: string) => {
      const rendered = renderOutputText(text, tables);
      return suffix ? `${rendered} ${renderOutputText(suffix, tables)}` : rendered;
    };
    const locations = Object.entries(rule.atLocation);
    catalog[rule.code] = Object.freeze({
      rule: close(rule.statement),
      ...(locations.length > 0
        ? {
            atLocation: Object.freeze(
              Object.fromEntries(locations.map(([location, text]) => [location, close(text)])),
            ),
          }
        : {}),
    });
  }
  return Object.freeze(catalog);
}

/** Retry hints for every model-correctable catalog rule. */
export const OUTPUT_RULE_HINTS = outputRuleHintCatalog();

/**
 * Whether the catalog lets a bounded retry repair `code`. A code outside the
 * catalog is not correctable here; its own validator decides.
 */
export function isModelCorrectableOutputRule(code: unknown): boolean {
  return outputRuleFor(code)?.retry === "model-correctable";
}

export { OUTPUT_RULE_FAILURE_CLASSES } from "./model-output-failure-classes.js";
