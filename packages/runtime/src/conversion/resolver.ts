// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  AMBIGUITY_UNIT_SCHEMA_VERSION,
  CONVERSION_IR_SCHEMA_VERSION,
  CONVERSION_NODE_KINDS,
  ConversionContractError,
  NORMALIZED_DIRECTIVE_NODE_KINDS,
  type AmbiguityUnit,
  type ConstructDisposition,
  type ConstructKey,
  type ConstructRuleRegistry,
  type ConversionDocument,
  type ConversionIrV1,
  type ConversionNode,
  type ConversionRuleOverride,
  type ConversionRuleProvenance,
  type DispositionName,
  type DropLedgerEntry,
  type SourceSpan,
} from "./contracts.js";
import {
  CONSTRUCT_RULE_REGISTRY,
  DIRECTIVE_FALLBACK_KEY,
  ROLE_FALLBACK_KEY,
  constructRuleRegistryDigest,
} from "./registry.js";

export type RuleSource = "registry" | "plan-rule";

export interface IndexedRule {
  /** The registry or plan-rule key that decided; a fallback key for an unregistered name. */
  key: ConstructKey;
  disposition: ConstructDisposition;
  source: RuleSource;
  provenance?: ConversionRuleProvenance;
}

export interface SubstitutionRule {
  literal: string;
  provenance: ConversionRuleProvenance;
}

/** A registry checked for exactly one rule per construct, with plan-level rules applied. */
export interface ConstructRuleIndex {
  registryVersion: number;
  registryDigest: string;
  rules: ReadonlyMap<ConstructKey, IndexedRule>;
  substitutions: ReadonlyMap<string, SubstitutionRule>;
}

export interface NodeResolution {
  nodeId: string;
  documentId: string;
  construct: ConstructKey;
  rule: IndexedRule;
}

export interface ConstructInventoryEntry {
  construct: ConstructKey;
  disposition: DispositionName;
  source: RuleSource;
  count: number;
}

/** A node whose rule is `refuse`; the plan cannot be approved while one remains. */
export interface ConstructRefusal {
  nodeId: string;
  documentId: string;
  sourcePath: string;
  construct: ConstructKey;
  reason: string;
  text: string;
  span: SourceSpan;
}

export interface ConversionResolution {
  schemaVersion: 1;
  registryVersion: number;
  registryDigest: string;
  nodes: NodeResolution[];
  /** One entry per construct, sorted by construct. */
  inventory: ConstructInventoryEntry[];
  /** Reader drops followed by resolver drops, in document order. */
  dropLedger: DropLedgerEntry[];
  units: AmbiguityUnit[];
  refusals: ConstructRefusal[];
}

const NODE_KINDS: ReadonlySet<string> = new Set(CONVERSION_NODE_KINDS);
const TYPED_NODE_KINDS = CONVERSION_NODE_KINDS.filter(
  (kind) => kind !== "directive" && kind !== "role" && kind !== "include",
);
const INCLUDE_KEYS: readonly ConstructKey[] = [
  "include:markup",
  "include:literal",
  "include:remote",
];

function isNormalizedDirective(name: string): boolean {
  return Object.hasOwn(NORMALIZED_DIRECTIVE_NODE_KINDS, name);
}

/** `raw` with an `html` format among its formats; readers turn it into an html node. */
function isRawHtml(name: string, argument: string | undefined): boolean {
  return name === "raw" && (argument ?? "").toLowerCase().split(/\s+/u).includes("html");
}

function isLowerCase(name: string): boolean {
  return name === name.toLowerCase();
}

/** The registry key for one node. Refuses a kind the IR does not define. */
export function constructKeyOf(node: ConversionNode): ConstructKey {
  const kind: string = node.kind;
  if (!NODE_KINDS.has(kind)) {
    throw new ConversionContractError(
      "conversion-unknown-node-kind",
      `Conversion IR node ${String(node.id)} has unknown kind ${JSON.stringify(kind)}.`,
      { nodeId: String(node.id) },
    );
  }
  switch (node.kind) {
    case "directive":
      return `directive:${node.name}`;
    case "role":
      return `role:${node.name}`;
    case "include":
      return node.target.kind === "remote" ? "include:remote" : `include:${node.mode}`;
    default:
      return `node:${node.kind}`;
  }
}

function checkRegistryRule(key: ConstructKey, disposition: ConstructDisposition): void {
  const invalid = (detail: string): never => {
    throw new ConversionContractError(
      "conversion-registry-invalid",
      `Registry rule ${key} ${detail}.`,
      { construct: key },
    );
  };
  const [family] = key.split(":", 1);
  const name = key.slice(`${family}:`.length);
  if (family === "node" && !(TYPED_NODE_KINDS as readonly string[]).includes(name)) {
    invalid("names no typed node kind of the conversion IR");
  }
  if (family === "include" && !INCLUDE_KEYS.includes(key)) {
    invalid("names no include mode");
  }
  if (family !== "node" && family !== "include" && family !== "directive" && family !== "role") {
    invalid("names no construct family");
  }
  if (family === "directive" && isNormalizedDirective(name)) {
    invalid("names a directive that readers turn into a typed node");
  }
  if ((family === "directive" || family === "role") && !isLowerCase(name)) {
    invalid("names a directive or role that is not lower case");
  }
  if (disposition.disposition === "judge") {
    const fits =
      disposition.unitKind === "remote-include"
        ? key === "include:remote"
        : family === "directive" || family === "role";
    if (!fits) invalid(`cannot produce a ${disposition.unitKind} unit`);
  }
}

function overrideDisposition(
  override: Extract<ConversionRuleOverride, { kind: "construct" }>,
  registryRules: ReadonlyMap<ConstructKey, IndexedRule>,
): ConstructDisposition {
  const invalid = (detail: string): never => {
    throw new ConversionContractError(
      "conversion-override-invalid",
      `Plan-level rule for ${override.construct} ${detail}.`,
      { construct: override.construct },
    );
  };
  const { construct } = override;
  if (construct === DIRECTIVE_FALLBACK_KEY || construct === ROLE_FALLBACK_KEY) {
    invalid("names a fallback key instead of one directive or role");
  }
  if (!construct.startsWith("directive:") && !construct.startsWith("role:")) {
    invalid("does not name a directive or role");
  }
  if (
    construct.startsWith("directive:") &&
    isNormalizedDirective(construct.slice("directive:".length))
  ) {
    invalid("names a directive that readers turn into a typed node");
  }
  if (!isLowerCase(construct)) invalid("names a directive or role that is not lower case");
  const rule = override.override;
  switch (rule.rule) {
    case "map-to-construct": {
      const target = registryRules.get(rule.construct);
      if (target === undefined || target.disposition.disposition !== "convert") {
        return invalid(`maps to ${rule.construct}, which is not a registered convert rule`);
      }
      if (rule.construct.split(":", 1)[0] !== construct.split(":", 1)[0]) {
        invalid(`maps to ${rule.construct}, which is not of the same construct family`);
      }
      if (rule.parameters === undefined) return target.disposition;
      const base = target.disposition.convert;
      const { parameters } = rule;
      // Parameters tune the mapped intent. A different intent, or a table read
      // from another source shape, is a different rule.
      if (
        parameters.target !== base.target ||
        (parameters.target === "table" && base.target === "table" && parameters.from !== base.from)
      ) {
        invalid(
          `sets parameters for ${parameters.target}, but ${rule.construct} converts to ${base.target}`,
        );
      }
      return { disposition: "convert", convert: parameters };
    }
    case "keep-literal":
      if (rule.text.trim().length === 0) invalid("keeps blank literal text");
      return { disposition: "convert", convert: { target: "literal-text", text: rule.text } };
    case "drop":
      if (rule.reason.trim().length === 0) invalid("drops without a reason");
      return {
        disposition: "drop-with-notice",
        reason: {
          code: override.provenance.source === "judged-answer" ? "judged-answer" : "operator-rule",
          text: rule.reason,
        },
      };
  }
}

/**
 * Check that the registry gives every construct exactly one rule and apply
 * plan-level rules. A plan-level rule replaces the registry rule for its
 * construct; two plan-level rules for one construct are refused.
 */
export function buildConstructRuleIndex(
  registry: ConstructRuleRegistry = CONSTRUCT_RULE_REGISTRY,
  overrides: readonly ConversionRuleOverride[] = [],
): ConstructRuleIndex {
  const registryRules = new Map<ConstructKey, IndexedRule>();
  for (const { construct, rule } of registry.rules) {
    if (registryRules.has(construct)) {
      throw new ConversionContractError(
        "conversion-construct-ambiguous",
        `The construct rule registry has more than one rule for ${construct}.`,
        { construct },
      );
    }
    checkRegistryRule(construct, rule);
    registryRules.set(construct, { key: construct, disposition: rule, source: "registry" });
  }
  const required: ConstructKey[] = [
    ...TYPED_NODE_KINDS.map((kind): ConstructKey => `node:${kind}`),
    ...INCLUDE_KEYS,
    DIRECTIVE_FALLBACK_KEY,
    ROLE_FALLBACK_KEY,
  ];
  for (const construct of required) {
    if (!registryRules.has(construct)) {
      throw new ConversionContractError(
        "conversion-construct-unregistered",
        `The construct rule registry has no rule for ${construct}.`,
        { construct },
      );
    }
  }

  const rules = new Map(registryRules);
  const planned = new Set<string>();
  const substitutions = new Map<string, SubstitutionRule>();
  for (const override of overrides) {
    if (override.kind === "substitution") {
      if (substitutions.has(override.name)) {
        throw new ConversionContractError(
          "conversion-construct-ambiguous",
          `The plan has more than one rule for substitution ${override.name}.`,
          { construct: `substitution:${override.name}` },
        );
      }
      if (override.literal.trim().length === 0) {
        throw new ConversionContractError(
          "conversion-override-invalid",
          `Plan-level rule for substitution ${override.name} sets blank literal text.`,
          { construct: `substitution:${override.name}` },
        );
      }
      substitutions.set(override.name, {
        literal: override.literal,
        provenance: override.provenance,
      });
      continue;
    }
    if (planned.has(override.construct)) {
      throw new ConversionContractError(
        "conversion-construct-ambiguous",
        `The plan has more than one rule for ${override.construct}.`,
        { construct: override.construct },
      );
    }
    planned.add(override.construct);
    rules.set(override.construct, {
      key: override.construct,
      disposition: overrideDisposition(override, registryRules),
      source: "plan-rule",
      provenance: override.provenance,
    });
  }

  return {
    registryVersion: registry.version,
    registryDigest: constructRuleRegistryDigest(registry),
    rules,
    substitutions,
  };
}

/**
 * The registry key for one node, after refusing what a reader should have
 * normalized: an unknown kind, a directive with a typed node, or a name that
 * is not lower case.
 */
function readerConstructKey(node: ConversionNode): ConstructKey {
  const construct = constructKeyOf(node);
  if (node.kind !== "directive" && node.kind !== "role") return construct;
  if (!isLowerCase(node.name)) {
    throw new ConversionContractError(
      "conversion-construct-name-not-normalized",
      `${node.kind === "directive" ? "Directive" : "Role"} node ${node.id} is named ${JSON.stringify(node.name)}, which is not lower case.`,
      { construct, nodeId: node.id },
    );
  }
  if (node.kind === "directive" && isNormalizedDirective(node.name)) {
    throw new ConversionContractError(
      "conversion-directive-not-normalized",
      `Directive node ${node.id} is ${node.name}, which readers turn into a ${NORMALIZED_DIRECTIVE_NODE_KINDS[node.name as keyof typeof NORMALIZED_DIRECTIVE_NODE_KINDS]} node.`,
      { construct, nodeId: node.id },
    );
  }
  if (node.kind === "directive" && isRawHtml(node.name, node.argument)) {
    throw new ConversionContractError(
      "conversion-directive-not-normalized",
      `Directive node ${node.id} is raw HTML, which readers turn into an html node.`,
      { construct, nodeId: node.id },
    );
  }
  return construct;
}

/** The one rule that decides a node. */
export function resolveNodeRule(
  index: ConstructRuleIndex,
  node: ConversionNode,
): { construct: ConstructKey; rule: IndexedRule } {
  const construct = readerConstructKey(node);
  const fallback =
    node.kind === "directive"
      ? DIRECTIVE_FALLBACK_KEY
      : node.kind === "role"
        ? ROLE_FALLBACK_KEY
        : undefined;
  const rule =
    index.rules.get(construct) ?? (fallback === undefined ? undefined : index.rules.get(fallback));
  if (rule === undefined) {
    throw new ConversionContractError(
      "conversion-construct-unregistered",
      `No rule decides ${construct} for node ${node.id}.`,
      { construct, nodeId: node.id },
    );
  }
  return { construct, rule };
}

function childrenOf(node: ConversionNode): readonly ConversionNode[] {
  switch (node.kind) {
    case "heading":
    case "paragraph":
    case "listItem":
    case "blockquote":
    case "footnoteDefinition":
    case "emphasis":
    case "strong":
    case "link":
      return node.children;
    case "list":
      return node.items;
    case "table":
      return [
        ...[...node.headerRows, ...node.bodyRows].flatMap((row) =>
          row.cells.flatMap((cell) => cell.children),
        ),
        ...(node.caption ?? []),
      ];
    case "definitionList":
      return node.items.flatMap((item) => [...item.term, ...item.definition]);
    case "fieldList":
      return node.fields.flatMap((field) => [...field.name, ...field.body]);
    case "lineBlock":
      return node.lines.flat();
    case "figure":
      return [node.image, ...node.caption, ...node.legend];
    case "directive":
      return node.body.kind === "blocks" ? node.body.children : [];
    case "thematicBreak":
    case "codeBlock":
    case "target":
    case "comment":
    case "html":
    case "math":
    case "image":
    case "include":
    case "text":
    case "inlineCode":
    case "inlineImage":
    case "inlineHtml":
    case "inlineMath":
    case "lineBreak":
    case "footnoteReference":
    case "substitutionReference":
    case "role":
      return [];
    default: {
      const unknown: never = node;
      return unknown;
    }
  }
}

function nodeUnit(
  node: ConversionNode,
  construct: ConstructKey,
  disposition: Extract<ConstructDisposition, { disposition: "judge" }>,
  document: ConversionDocument,
  ir: ConversionIrV1,
): AmbiguityUnit {
  const base = {
    schemaVersion: AMBIGUITY_UNIT_SCHEMA_VERSION,
    id: `unit:node:${node.id}`,
    excerpt: { documentId: document.id, sourcePath: document.sourcePath, span: node.span },
  } as const;
  if (
    disposition.unitKind === "remote-include" &&
    node.kind === "include" &&
    node.target.kind === "remote"
  ) {
    return {
      ...base,
      kind: "remote-include",
      construct: "include:remote",
      nodeId: node.id,
      url: node.target.url,
    };
  }
  if (node.kind === "directive" || node.kind === "role") {
    const named = construct as `directive:${string}` | `role:${string}`;
    if (disposition.unitKind === "conditional-content") {
      return {
        ...base,
        kind: "conditional-content",
        construct: named,
        nodeId: node.id,
        condition: node.kind === "directive" ? (node.argument ?? "") : node.content,
      };
    }
    if (disposition.unitKind === "custom-construct") {
      return {
        ...base,
        kind: "custom-construct",
        construct: named,
        nodeId: node.id,
        name: node.name,
        ...(node.kind === "directive" && node.argument !== undefined
          ? { argument: node.argument }
          : {}),
        options: node.kind === "directive" ? node.options : [],
        extensionModules: ir.source.extensionModules,
      };
    }
  }
  throw new ConversionContractError(
    "conversion-registry-invalid",
    `Rule ${construct} cannot produce a ${disposition.unitKind} unit for node ${node.id}.`,
    { construct, nodeId: node.id },
  );
}

/**
 * Give every node in the IR exactly one disposition. Dropped nodes enter the
 * drop ledger with their subtrees, which are still checked for reader defects
 * but get no disposition of their own; judged nodes yield ambiguity units;
 * refused nodes are listed so the plan cannot be approved until a rule covers
 * them.
 */
export function resolveConversionIr(
  ir: ConversionIrV1,
  options: {
    registry?: ConstructRuleRegistry;
    overrides?: readonly ConversionRuleOverride[];
  } = {},
): ConversionResolution {
  if ((ir.schemaVersion as number) !== CONVERSION_IR_SCHEMA_VERSION) {
    throw new ConversionContractError(
      "conversion-ir-schema-unsupported",
      `Conversion IR schema version ${String(ir.schemaVersion)} is not supported; expected ${CONVERSION_IR_SCHEMA_VERSION}.`,
    );
  }
  const index = buildConstructRuleIndex(options.registry, options.overrides);
  const substitutionNames = new Set<string>();
  for (const entry of ir.substitutions) {
    if (substitutionNames.has(entry.name)) {
      throw new ConversionContractError(
        "conversion-ir-id-duplicate",
        `The substitution table has more than one entry named ${entry.name}.`,
        { construct: `substitution:${entry.name}` },
      );
    }
    substitutionNames.add(entry.name);
  }
  for (const name of index.substitutions.keys()) {
    if (!substitutionNames.has(name)) {
      throw new ConversionContractError(
        "conversion-override-invalid",
        `Plan-level rule for substitution ${name} names no substitution in the IR.`,
        { construct: `substitution:${name}` },
      );
    }
  }
  const seenIds = new Set<string>();
  const claimId = (node: ConversionNode): void => {
    if (seenIds.has(node.id)) {
      throw new ConversionContractError(
        "conversion-ir-id-duplicate",
        `More than one conversion IR node has id ${node.id}.`,
        { nodeId: node.id },
      );
    }
    seenIds.add(node.id);
  };
  const checkDropped = (node: ConversionNode): void => {
    claimId(node);
    readerConstructKey(node);
    for (const child of childrenOf(node)) checkDropped(child);
  };
  const nodes: NodeResolution[] = [];
  const dropLedger: DropLedgerEntry[] = [...ir.dropLedger];
  const units: AmbiguityUnit[] = [];
  const refusals: ConstructRefusal[] = [];
  const counts = new Map<ConstructKey, ConstructInventoryEntry>();

  const visit = (node: ConversionNode, document: ConversionDocument): void => {
    claimId(node);
    const { construct, rule } = resolveNodeRule(index, node);
    nodes.push({ nodeId: node.id, documentId: document.id, construct, rule });
    const { disposition } = rule;
    const counted = counts.get(construct);
    if (counted) counted.count += 1;
    else {
      counts.set(construct, {
        construct,
        disposition: disposition.disposition,
        source: rule.source,
        count: 1,
      });
    }
    switch (disposition.disposition) {
      case "drop-with-notice":
        dropLedger.push({
          nodeId: node.id,
          documentId: document.id,
          sourcePath: document.sourcePath,
          construct,
          reason: disposition.reason,
          span: node.span,
        });
        for (const child of childrenOf(node)) checkDropped(child);
        return;
      case "judge":
        units.push(nodeUnit(node, construct, disposition, document, ir));
        break;
      case "refuse":
        refusals.push({
          nodeId: node.id,
          documentId: document.id,
          sourcePath: document.sourcePath,
          construct,
          reason: disposition.reason,
          text: disposition.text,
          span: node.span,
        });
        break;
      case "convert":
        break;
    }
    for (const child of childrenOf(node)) visit(child, document);
  };

  for (const document of ir.documents) {
    for (const block of document.children) visit(block, document);
  }

  for (const entry of ir.substitutions) {
    if (entry.value.kind !== "computed" || index.substitutions.has(entry.name)) continue;
    const { origin } = entry;
    const excerpt =
      origin.kind === "document"
        ? { documentId: origin.documentId, sourcePath: origin.sourcePath, span: origin.span }
        : { sourcePath: origin.path, span: origin.span };
    units.push({
      schemaVersion: AMBIGUITY_UNIT_SCHEMA_VERSION,
      id: `unit:substitution:${entry.name}`,
      kind: "non-literal-substitution",
      excerpt,
      name: entry.name,
      expression: entry.value.expression,
    });
  }

  const inventory = [...counts.values()].sort((left, right) =>
    left.construct < right.construct ? -1 : left.construct > right.construct ? 1 : 0,
  );
  return {
    schemaVersion: 1,
    registryVersion: index.registryVersion,
    registryDigest: index.registryDigest,
    nodes,
    inventory,
    dropLedger,
    units,
    refusals,
  };
}
