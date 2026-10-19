// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ConversionBlock, ConversionInline, ConversionNode } from "../contracts.js";
import { FLOW_START, LINE, mismatch, type FernEmitContext } from "./context.js";
import {
  encodeLinkDestination,
  escapeHeadingTail,
  escapeMdxText,
  inlineCodeSpan,
  linkTitle,
  type TextPosition,
} from "./escape.js";
import { htmlCell } from "./tables.js";

/** Markdown has six ATX heading levels; deeper source headings are written at the last. */
const ATX_HEADING_MARKERS = ["#", "##", "###", "####", "#####", "######"] as const;
const LIST_BULLET = "-";
const THEMATIC_BREAK = "***";
const LINE_BREAK = "<br />";

/** Wrap inline content in a delimiter pair, keeping edge whitespace outside it. */
export function delimited(delimiter: string, content: string): string {
  const match = /^(\s*)([\s\S]*?)(\s*)$/u.exec(content);
  const [, lead = "", core = "", trail = ""] = match ?? [];
  return core === "" ? content : `${lead}${delimiter}${core}${delimiter}${trail}`;
}

export function markdownLink(text: string, url: string, title?: string): string {
  const suffix = title === undefined ? "" : ` ${linkTitle(title)}`;
  return `[${text}](${encodeLinkDestination(url)}${suffix})`;
}

export function markdownImage(
  alt: string,
  source: string,
  mode: TextPosition["mode"],
  title?: string,
): string {
  const escapedAlt = escapeMdxText(alt, { lineStart: false, mode });
  const suffix = title === undefined ? "" : ` ${linkTitle(title)}`;
  return `![${escapedAlt}](${encodeLinkDestination(source)}${suffix})`;
}

function footnoteLabel(label: string): string {
  // Keep GFM-valid punctuation and encode every other code point injectively.
  // Underscores are encoded too, so the marker cannot collide with source text.
  return [...label]
    .map((char) => (/^[a-z0-9.-]$/u.test(char) ? char : `_u${char.codePointAt(0)?.toString(16)}_`))
    .join("");
}

function indentLines(text: string, indent: string): string {
  return text
    .split("\n")
    .map((line) => (line === "" ? "" : `${indent}${line}`))
    .join("\n");
}

/** A list item holding one paragraph, optionally followed by one nested list, stays tight. */
function isTightItem(children: readonly ConversionBlock[]): boolean {
  if (children.length <= 1) return true;
  return children.length === 2 && children[0]?.kind === "paragraph" && children[1]?.kind === "list";
}

function renderList(
  node: Extract<ConversionBlock, { kind: "list" }>,
  context: FernEmitContext,
): string {
  const tight = node.items.every((item) => isTightItem(item.children));
  const first = node.start ?? 1;
  const items = node.items.map((item, index) => {
    const marker = node.ordered ? `${first + index}.` : LIST_BULLET;
    const blocks = item.children
      .map((child) => context.emitBlock(child))
      .filter((part) => part !== "");
    const body = tight ? blocks.join("\n") : context.joinBlocks(blocks);
    if (body === "") return marker;
    const [head = "", ...rest] = body.split("\n");
    const indent = " ".repeat(marker.length + 1);
    return [
      `${marker} ${head}`,
      ...rest.map((line) => (line === "" ? "" : `${indent}${line}`)),
    ].join("\n");
  });
  return items.join(tight ? "\n" : "\n\n");
}

function definitionList(
  items: ReadonlyArray<{ term: ConversionInline[]; body: ConversionBlock[] }>,
  context: FernEmitContext,
): string {
  const lines = ["<dl>"];
  for (const item of items) {
    lines.push(`<dt>${context.emitInlines(item.term, LINE)}</dt>`);
    lines.push(htmlCell("dd", { blocks: item.body }, context));
  }
  lines.push("</dl>");
  return lines.join("\n");
}

export function headingLine(
  depth: number,
  content: string,
  node: ConversionNode,
  context: FernEmitContext,
): string {
  const clipped = Math.min(Math.max(depth, 1), ATX_HEADING_MARKERS.length);
  if (clipped !== depth) {
    context.notice("heading-depth-clipped", node, `Depth ${depth} is written as depth ${clipped}.`);
  }
  const text = escapeHeadingTail(content);
  return `${ATX_HEADING_MARKERS[clipped - 1]}${text === "" ? "" : ` ${text}`}`;
}

export function markdownBlock(node: ConversionBlock, context: FernEmitContext): string {
  switch (node.kind) {
    case "heading":
      return headingLine(node.depth, context.emitInlines(node.children, LINE), node, context);
    case "paragraph":
      return context.emitInlines(node.children, FLOW_START);
    case "list":
      return renderList(node, context);
    case "listItem":
      return context.emitBlocks(node.children);
    case "blockquote": {
      const body = context.emitBlocks(node.children);
      return body
        .split("\n")
        .map((line) => (line === "" ? ">" : `> ${line}`))
        .join("\n");
    }
    case "thematicBreak":
      return THEMATIC_BREAK;
    case "definitionList":
      return definitionList(
        node.items.map((item) => ({ term: item.term, body: item.definition })),
        context,
      );
    case "fieldList":
      return definitionList(
        node.fields.map((field) => ({ term: field.name, body: field.body })),
        context,
      );
    case "lineBlock":
      return node.lines
        .map((line) => context.emitInlines(line, FLOW_START))
        .join(`${LINE_BREAK}\n`);
    case "footnoteDefinition": {
      const body = context.emitBlocks(node.children);
      const [head = "", ...rest] = body.split("\n");
      const label = `[^${footnoteLabel(node.label)}]:`;
      return [`${label}${head === "" ? "" : ` ${head}`}`, indentLines(rest.join("\n"), "    ")]
        .filter((part) => part !== "")
        .join("\n");
    }
    default:
      return mismatch(context, node, "markdown");
  }
}

export function markdownInline(
  node: ConversionInline,
  context: FernEmitContext,
  position: TextPosition,
): string {
  const inner: TextPosition = { lineStart: false, mode: position.mode };
  switch (node.kind) {
    case "text":
      return escapeMdxText(node.value, position);
    case "emphasis":
      return delimited("*", context.emitInlines(node.children, inner));
    case "strong":
      return delimited("**", context.emitInlines(node.children, inner));
    case "inlineCode":
      return inlineCodeSpan(node.value);
    case "link": {
      const text =
        node.children.length === 0
          ? escapeMdxText(node.url, inner)
          : context.emitInlines(node.children, inner);
      return markdownLink(text, node.url, node.title);
    }
    case "lineBreak":
      return LINE_BREAK;
    case "footnoteReference":
      return `[^${footnoteLabel(node.label)}]`;
    default:
      return mismatch(context, node, "markdown");
  }
}
