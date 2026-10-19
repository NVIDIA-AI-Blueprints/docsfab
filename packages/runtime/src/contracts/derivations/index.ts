// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Runtime-owned derivation rules for records-mode contracts
 * (planning/design/closed-schema-answer-records-decision.md §1.2).
 *
 * A contract whose `owner` is `runtime` implements each rule its declaration
 * names once, as `src/contracts/derivations/<contract>.ts` exporting a
 * `RuntimeDerivationRules<C>`: the generated `DerivationRuleOf<C>` makes a
 * missing or extra rule a compile error. `deriveWithRuntimeRules` turns that
 * table into the derive step `assembleAnswerRecords` runs. Quality-owned
 * rules are Python (`quality_decision_policy.RULES`) and run through the
 * quality validator host instead.
 */

import type {
  AnswerRecordDerivation,
  AnswerRecordDraft,
  AssembledAnswerRecord,
} from "../../harness/answer-records.js";
import { AnswerRecordHostError, parseRecordLocation } from "../../harness/answer-records.js";
import type {
  AnswerRecordContractDeclaration,
  DerivationRuleOf,
  RecordContractId,
} from "../model-output.js";

/** What a rule reads: the draft artifact, the admitted records, and the member's concrete path. */
export interface DerivationContext {
  readonly artifact: Readonly<Record<string, unknown>>;
  readonly records: readonly AssembledAnswerRecord[];
  /** The concrete path of the member being derived; empty for a compose host part. */
  readonly path: readonly (string | number)[];
}

export type DerivationRule = (context: DerivationContext) => unknown;

/** Every rule a generated runtime-owned contract names, keyed without its `runtime:` owner. */
export type RuntimeDerivationRules<C extends RecordContractId> = Readonly<
  Record<DerivationRuleOf<C> extends `runtime:${infer Rule}` ? Rule : never, DerivationRule>
>;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Concrete paths of the existing parents of `location`'s last member, in artifact order. */
function parents(
  artifact: Record<string, unknown>,
  location: string,
): { paths: (string | number)[][]; member: string } {
  const segments = parseRecordLocation(location);
  const last = segments.at(-1)!;
  if (!("prop" in last))
    throw new AnswerRecordHostError(
      `The derived member location ${location} must end in a member name.`,
    );
  let frontier: { node: unknown; path: (string | number)[] }[] = [{ node: artifact, path: [] }];
  for (const segment of segments.slice(0, -1)) {
    const next: typeof frontier = [];
    for (const { node, path } of frontier) {
      if ("items" in segment) {
        if (Array.isArray(node))
          node.forEach((item, index) => next.push({ node: item, path: [...path, index] }));
      } else if (isObject(node)) {
        const names = "prop" in segment ? [segment.prop] : Object.keys(node);
        for (const name of names) {
          if (Object.hasOwn(node, name)) next.push({ node: node[name], path: [...path, name] });
        }
      }
    }
    frontier = next;
  }
  return {
    paths: frontier.filter((entry) => isObject(entry.node)).map((entry) => entry.path),
    member: last.prop,
  };
}

/**
 * The derive step for a runtime-owned contract: each declared `derive` member
 * is written at every existing parent by its rule, and each compose host part
 * that names a rule is computed once. A rule the table lacks is a host defect.
 */
export function deriveWithRuntimeRules(
  declaration: Pick<AnswerRecordContractDeclaration, "derive" | "compose">,
  rules: Readonly<Record<string, DerivationRule>>,
): (draft: AnswerRecordDraft) => AnswerRecordDerivation {
  const ruleFor = (name: string): DerivationRule => {
    const match = /^runtime:(.+)$/u.exec(name);
    const rule = match ? rules[match[1]!] : undefined;
    if (!rule)
      throw new AnswerRecordHostError(
        `The runtime derivation table has no implementation for rule ${name}.`,
      );
    return rule;
  };
  return (draft) => {
    const artifact = structuredClone(draft.artifact);
    for (const entry of declaration.derive) {
      const rule = ruleFor(entry.rule);
      const { paths, member } = parents(artifact, entry.field);
      for (const path of paths) {
        let node: unknown = artifact;
        for (const step of path) node = (node as Record<string | number, unknown>)[step];
        (node as Record<string, unknown>)[member] = rule({
          artifact,
          records: draft.records,
          path: [...path, member],
        });
      }
    }
    const hostParts: Record<string, readonly unknown[]> = {};
    for (const entry of declaration.compose) {
      for (const part of entry.parts) {
        if (!("host" in part) || part.host.startsWith("reference:")) continue;
        const items = ruleFor(part.host)({ artifact, records: draft.records, path: [] });
        if (!Array.isArray(items)) {
          throw new AnswerRecordHostError(`Rule ${part.host} must return a list of items.`);
        }
        hostParts[part.host] = items;
      }
    }
    return { status: "derived", artifact, hostParts };
  };
}
