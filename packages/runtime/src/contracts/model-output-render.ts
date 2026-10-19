// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Catalog rendering resolves limits only when a prompt or hint is rendered. */

import { limit } from "../config/limits.js";
import {
  OUTPUT_CONTRACTS,
  OUTPUT_GRAMMARS,
  OUTPUT_REPLAY_MODES,
  OUTPUT_RULE_FAMILIES,
  OUTPUT_RULES,
  outputRuleFor,
  type HostBlockOf,
  type OutputContractDeclaration,
  type OutputContractId,
  type OutputGrammarDeclaration,
  type OutputReplayMode,
  type OutputRuleDeclaration,
  type OutputRuleFamilyDeclaration,
} from "./model-output.generated.js";

export * from "./model-output.generated.js";

type RuleTable = Readonly<Record<string, OutputRuleDeclaration>>;
type FamilyTable = Readonly<Record<string, OutputRuleFamilyDeclaration>>;
type ReplayModeTable = Readonly<Record<OutputReplayMode, { readonly statement: string | null }>>;

/** The catalog tables a derivation reads; tests pass their own. */
export interface OutputCatalogTables {
  readonly rules: RuleTable;
  readonly families: FamilyTable;
  readonly replayModes: ReplayModeTable;
  readonly grammars: Readonly<Record<string, OutputGrammarDeclaration>>;
  readonly limitValue: (name: string) => number;
}

const PLACEHOLDER = /\{(limit|grammar):([^{}]+)\}/gu;

export function catalogTables(): OutputCatalogTables {
  return {
    rules: OUTPUT_RULES,
    families: OUTPUT_RULE_FAMILIES,
    replayModes: OUTPUT_REPLAY_MODES,
    grammars: OUTPUT_GRAMMARS,
    limitValue: (name) => limit(name).value,
  };
}

/**
 * Catalog text with its placeholders rendered: `{limit:<name>}` becomes the
 * effective limit value and `{grammar:<id>}` the grammar's statement. The
 * generator has already refused an unknown name, so an unresolved placeholder
 * is left as written rather than guessed.
 */
export function renderOutputText(
  text: string,
  tables: Pick<OutputCatalogTables, "grammars" | "limitValue"> = catalogTables(),
): string {
  return text.replaceAll(PLACEHOLDER, (placeholder, type: string, name: string) => {
    if (type === "limit") return String(tables.limitValue(name));
    return Object.hasOwn(tables.grammars, name) ? tables.grammars[name]!.statement : placeholder;
  });
}

/**
 * The contract text a binder appends to a step prompt, one line per entry:
 * the title, then each rule's sentence, fixed note, or host block (its label
 * line, then the value the binder rendered from sealed host input).
 */
export function renderResponseContract<K extends OutputContractId>(
  id: K,
  hostBlocks: Readonly<Record<HostBlockOf<K>, string>>,
  tables: Pick<OutputCatalogTables, "grammars" | "limitValue"> = catalogTables(),
): string {
  const contract: OutputContractDeclaration = OUTPUT_CONTRACTS[id];
  const blocks = hostBlocks as Readonly<Record<string, string>>;
  const lines = [contract.title];
  for (const entry of contract.render) {
    if ("rule" in entry) lines.push(renderOutputText(entry.text, tables));
    else if ("note" in entry) lines.push(renderOutputText(entry.note, tables));
    else lines.push(entry.label, blocks[entry.host]!);
  }
  return lines.join("\n");
}
