// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ConversionBlock, ConversionInline, DirectiveNode } from "../contracts.js";
import { LINE, argumentText, noticeOptions, optionValue, type FernEmitContext } from "./context.js";
import { csvDelimiter, parseCsv } from "./csv.js";
import { escapeMdxText } from "./escape.js";

/**
 * One HTML cell (`th`, `td`, `dd`). A single paragraph stays on the tag line;
 * other blocks sit between blank lines so MDX reads them as Markdown.
 */
export function htmlCell(tag: string, content: TableCellContent, context: FernEmitContext): string {
  if ("text" in content) return `<${tag}>${escapeMdxText(content.text, LINE)}</${tag}>`;
  const blocks = content.blocks;
  if (blocks.length === 0) return `<${tag}></${tag}>`;
  const only = blocks[0];
  if (blocks.length === 1 && only?.kind === "paragraph") {
    return `<${tag}>${context.emitInlines(only.children, LINE)}</${tag}>`;
  }
  return `<${tag}>\n\n${context.emitBlocks(blocks)}\n\n</${tag}>`;
}

export type TableCellContent = { blocks: readonly ConversionBlock[] } | { text: string };

export interface TableModel {
  header: TableCellContent[][];
  body: TableCellContent[][];
  caption?: readonly ConversionInline[] | string;
}

function pipeCell(content: TableCellContent, context: FernEmitContext): string | undefined {
  let rendered: string;
  if ("text" in content) {
    rendered = escapeMdxText(content.text, { lineStart: false, mode: "cell" });
  } else if (content.blocks.length === 0) {
    rendered = "";
  } else {
    const only = content.blocks[0];
    if (content.blocks.length !== 1 || only?.kind !== "paragraph") return undefined;
    rendered = context.emitInlines(only.children, { lineStart: false, mode: "cell" });
  }
  // A pipe inside a code span, math, or HTML still splits a GFM row.
  if (rendered.includes("|") && /[`$<]/u.test(rendered)) return undefined;
  return rendered;
}

/** A GFM pipe table when every cell is one line of inline content; otherwise an HTML table. */
export function renderTable(model: TableModel, context: FernEmitContext): string {
  const rows = [...model.header, ...model.body];
  const width = model.header[0]?.length ?? 0;
  const uniform = width > 0 && rows.every((row) => row.length === width);
  if (model.header.length === 1 && model.caption === undefined && uniform) {
    const rendered = rows.map((row) => row.map((cell) => pipeCell(cell, context)));
    if (rendered.every((row) => row.every((cell) => cell !== undefined))) {
      const line = (cells: ReadonlyArray<string | undefined>): string => `| ${cells.join(" | ")} |`;
      const [header = [], ...body] = rendered;
      return [line(header), line(header.map(() => "---")), ...body.map(line)].join("\n");
    }
  }
  const lines = ["<table>"];
  if (typeof model.caption === "string") {
    lines.push(`<caption>${escapeMdxText(model.caption, LINE)}</caption>`);
  } else if (model.caption !== undefined && model.caption.length > 0) {
    lines.push(`<caption>${context.emitInlines(model.caption, LINE)}</caption>`);
  }
  const section = (tag: string, cellTag: string, sectionRows: TableCellContent[][]): void => {
    if (sectionRows.length === 0) return;
    lines.push(`<${tag}>`);
    for (const row of sectionRows) {
      lines.push("<tr>", ...row.map((cell) => htmlCell(cellTag, cell, context)), "</tr>");
    }
    lines.push(`</${tag}>`);
  };
  section("thead", "th", model.header);
  section("tbody", "td", model.body);
  lines.push("</table>");
  return lines.join("\n");
}

function headerRowCount(
  node: DirectiveNode,
  rows: number,
  context: FernEmitContext,
): number | undefined {
  const value = optionValue(node, "header-rows");
  if (value === undefined) return 0;
  const count = /^[0-9]+$/u.test(value.trim()) ? Number(value.trim()) : Number.NaN;
  if (!Number.isInteger(count) || count > rows) {
    context.refuse(
      "fern-table-shape-invalid",
      node,
      `Directive ${node.name} node ${node.id} has :header-rows: ${value} for ${rows} rows.`,
    );
    return undefined;
  }
  return count;
}

export function listTableModel(
  node: DirectiveNode,
  context: FernEmitContext,
): TableModel | undefined {
  const invalid = (detail: string): undefined => {
    context.refuse("fern-table-shape-invalid", node, `list-table node ${node.id} ${detail}.`);
    return undefined;
  };
  if (node.body.kind !== "blocks") return invalid("has no parsed list body");
  const [list, ...extra] = node.body.children;
  if (list?.kind !== "list" || extra.length > 0) return invalid("does not hold exactly one list");
  const rows: TableCellContent[][] = [];
  for (const item of list.items) {
    const [cells, ...more] = item.children;
    if (cells?.kind !== "list" || more.length > 0) return invalid("has a row that is not one list");
    rows.push(cells.items.map((cell) => ({ blocks: cell.children })));
  }
  const width = rows[0]?.length ?? 0;
  if (width === 0 || rows.some((row) => row.length !== width)) {
    return invalid("has rows with different numbers of cells");
  }
  const headerRows = headerRowCount(node, rows.length, context);
  if (headerRows === undefined) return undefined;
  noticeOptions(context, node, node.options, ["header-rows"]);
  const caption = argumentText(node);
  return {
    header: rows.slice(0, headerRows),
    body: rows.slice(headerRows),
    ...(caption === undefined ? {} : { caption }),
  };
}

const CSV_PARSING_OPTIONS = ["quote", "escape", "keepspace"];

export function csvTableModel(
  node: DirectiveNode,
  context: FernEmitContext,
): TableModel | undefined {
  const invalid = (detail: string): undefined => {
    context.refuse("fern-table-shape-invalid", node, `csv-table node ${node.id} ${detail}.`);
    return undefined;
  };
  const unsupported = node.options.find((option) => CSV_PARSING_OPTIONS.includes(option.name));
  if (unsupported !== undefined)
    return invalid(`sets :${unsupported.name}:, which RFC 4180 parsing does not honor`);
  const delimiter = csvDelimiter(optionValue(node, "delim"));
  if (delimiter === undefined) return invalid("has a :delim: that is not one character");
  const url = optionValue(node, "url");
  if (url !== undefined) {
    context.refuse(
      "fern-source-remote",
      node,
      `csv-table node ${node.id} reads ${url}, which is never fetched.`,
    );
    return undefined;
  }
  const file = optionValue(node, "file");
  let source: string | undefined;
  if (file !== undefined) {
    if (node.body.kind !== "none") return invalid("has both :file: and a body");
    source = context.readText(node, file);
    if (source === undefined) return undefined;
  } else if (node.body.kind === "text") {
    source = node.body.value;
  } else if (node.body.kind === "none") {
    source = "";
  } else {
    context.refuse(
      "fern-body-unparsed",
      node,
      `csv-table node ${node.id} needs its body as CSV text.`,
    );
    return undefined;
  }
  const parsed = parseCsv(source, delimiter);
  if (!parsed.ok) return invalid(parsed.reason);
  const headerOption = optionValue(node, "header");
  const headerParsed = headerOption === undefined ? undefined : parseCsv(headerOption, delimiter);
  if (headerParsed !== undefined && !headerParsed.ok) return invalid(headerParsed.reason);
  const optionRows = headerParsed?.ok === true ? headerParsed.rows : [];
  const headerRows = headerRowCount(node, parsed.rows.length, context);
  if (headerRows === undefined) return undefined;
  const all = [...optionRows, ...parsed.rows];
  const width = Math.max(0, ...all.map((row) => row.length));
  const toCells = (row: readonly string[]): TableCellContent[] =>
    Array.from({ length: width }, (_, index) => ({ text: row[index] ?? "" }));
  noticeOptions(context, node, node.options, ["delim", "file", "header", "header-rows"]);
  const caption = argumentText(node);
  return {
    header: [...optionRows, ...parsed.rows.slice(0, headerRows)].map(toCells),
    body: parsed.rows.slice(headerRows).map(toCells),
    ...(caption === undefined ? {} : { caption }),
  };
}
