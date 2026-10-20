// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ConversionBlock, ConversionNode } from "../contracts.js";

/** Direct child nodes of one IR node, blocks and inlines, in source order. */
export function childNodes(node: ConversionNode): readonly ConversionNode[] {
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

/** Sibling block sequences nested directly inside one block. */
export function nestedBlockSequences(node: ConversionBlock): readonly ConversionBlock[][] {
  switch (node.kind) {
    case "listItem":
    case "blockquote":
    case "footnoteDefinition":
      return [node.children];
    case "list":
      return node.items.map((item) => [item]);
    case "table":
      return [...node.headerRows, ...node.bodyRows].flatMap((row) =>
        row.cells.map((cell) => cell.children),
      );
    case "definitionList":
      return node.items.map((item) => item.definition);
    case "fieldList":
      return node.fields.map((field) => field.body);
    case "figure":
      return [node.legend];
    case "directive":
      return node.body.kind === "blocks" ? [node.body.children] : [];
    default:
      return [];
  }
}

/** Visit every node in pre-order. */
export function visitNodes(
  nodes: readonly ConversionNode[],
  visit: (node: ConversionNode) => void,
): void {
  for (const node of nodes) {
    visit(node);
    visitNodes(childNodes(node), visit);
  }
}
