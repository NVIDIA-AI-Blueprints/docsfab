// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ConversionBlock,
  ConversionDocument,
  ConversionInline,
  ConversionIrV1,
  ConversionNode,
  DirectiveNode,
  IncludeNode,
  SourceOption,
} from "../contracts.js";
import { collapseWhitespace, jsxAttribute, type TextPosition } from "./escape.js";
import type { FernBuiltInComponent, FernEmitNoticeCode, FernEmitRefusalCode } from "./types.js";

/** Frontmatter keys a page node may set; the plan owns title, slug, and canonical URL. */
export type NodeFrontmatterKey = "description" | "keywords";

/** What an intent emitter may ask of the page it is writing into. */
export interface FernEmitContext {
  readonly ir: ConversionIrV1;
  readonly document: ConversionDocument;
  emitBlock(node: ConversionBlock): string;
  emitBlocks(nodes: readonly ConversionBlock[]): string;
  joinBlocks(parts: readonly string[]): string;
  emitInlines(nodes: readonly ConversionInline[], position: TextPosition): string;
  /** Record a refusal; the returned empty string keeps emission going so every refusal is reported. */
  refuse(code: FernEmitRefusalCode, node: ConversionNode, message: string): string;
  notice(code: FernEmitNoticeCode, node: ConversionNode, detail: string): void;
  setFrontmatter(key: NodeFrontmatterKey, value: string, node: ConversionNode): void;
  /** File text the caller supplies; refuses and returns undefined when it is missing. */
  readText(node: ConversionNode, path: string): string | undefined;
  /** The emitted blocks of a markup include, or undefined after a refusal. */
  includeDocument(node: IncludeNode, path: string): string | undefined;
  /** The literal value of a substitution, from a plan-level rule or the table. */
  substitution(name: string): string | undefined;
}

export type AttributeValue = string | { expression: string } | undefined;
export type Attribute = readonly [name: string, value: AttributeValue];

/** Block text at the start of a line, and single-line text after a tag or marker. */
export const FLOW_START: TextPosition = { lineStart: true, mode: "flow" };
export const LINE: TextPosition = { lineStart: false, mode: "line" };

export function mismatch(context: FernEmitContext, node: ConversionNode, target: string): string {
  return context.refuse(
    "fern-intent-node-mismatch",
    node,
    `Intent ${target} cannot render ${node.kind} node ${node.id}.`,
  );
}

export function component(
  name: FernBuiltInComponent,
  attributes: readonly Attribute[],
  body: string,
): string {
  const rendered = attributes.flatMap(([attribute, value]) => {
    if (value === undefined) return [];
    return typeof value === "string"
      ? [jsxAttribute(attribute, value)]
      : [`${attribute}={${value.expression}}`];
  });
  const open = `<${name}${rendered.length === 0 ? "" : ` ${rendered.join(" ")}`}>`;
  return body === "" ? `${open}\n</${name}>` : `${open}\n${body}\n</${name}>`;
}

export function argumentText(node: DirectiveNode): string | undefined {
  const text = collapseWhitespace(node.argument ?? "");
  return text === "" ? undefined : text;
}

export function optionValue(node: DirectiveNode, name: string): string | undefined {
  return node.options.find((option) => option.name === name)?.value;
}

export function describeOption(option: SourceOption): string {
  return option.value === undefined ? `:${option.name}:` : `:${option.name}: ${option.value}`;
}

export function noticeOptions(
  context: FernEmitContext,
  node: ConversionNode,
  options: readonly SourceOption[],
  consumed: readonly string[] = [],
): void {
  for (const option of options) {
    if (consumed.includes(option.name)) continue;
    context.notice("option-not-emitted", node, describeOption(option));
  }
}

export function directiveBody(node: DirectiveNode, context: FernEmitContext): string {
  switch (node.body.kind) {
    case "blocks":
      return context.emitBlocks(node.body.children);
    case "none":
      return "";
    case "text":
      return context.refuse(
        "fern-body-unparsed",
        node,
        `Directive ${node.name} node ${node.id} has an unparsed text body.`,
      );
    case "toctree":
      return context.refuse(
        "fern-intent-node-mismatch",
        node,
        `Directive ${node.name} node ${node.id} has navigation-owned content that cannot be emitted as page body.`,
      );
  }
}

/** An HTML anchor for a label, unless the label table says it names the whole page. */
export function anchorFor(context: FernEmitContext, label: string | undefined): string {
  if (label === undefined) return "";
  const entry = context.ir.labels.find(
    (candidate) => candidate.label === label && candidate.documentId === context.document.id,
  );
  if (entry !== undefined && entry.anchor === undefined) return "";
  return `<a ${jsxAttribute("id", entry?.anchor ?? label)} />`;
}

export function withAnchor(context: FernEmitContext, anchor: string, block: string): string {
  return context.joinBlocks([anchor, block]);
}
