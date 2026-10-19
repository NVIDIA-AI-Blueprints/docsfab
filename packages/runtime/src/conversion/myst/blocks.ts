// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  CodeBlockNode,
  ConversionBlock,
  ConversionInline,
  DirectiveNode,
  FigureNode,
  HeadingNode,
  ImageNode,
  IncludeNode,
  IncludeTarget,
  ListItemNode,
  ParagraphNode,
  SourceSpan,
  TableCell,
  TableColumnAlignment,
  TableRow,
  ToctreeEntry,
} from "../contracts.js";
import {
  OptionSet,
  TEXT_BODY_DIRECTIVES,
  bodyText,
  parseLineRanges,
  parsePositiveInteger,
  splitDirectiveContent,
} from "./directives.js";
import { normalizeLinkLabel, unescapeString, type LinkDefinition } from "./inline.js";
import {
  FenceTracker,
  TAB_STOP,
  closesFence,
  fenceOpening,
  indentOf,
  isBlank,
  stripIndent,
  withText,
  type FenceOpening,
  type SourceLine,
} from "./lines.js";

/** What the block parser needs from the document reader. */
export interface BlockContext {
  readonly definitions: Map<string, LinkDefinition>;
  /** Refuses when `depth` nested containers pass the nesting bound. */
  enterBlock(depth: number, line: number): void;
  /** Queue inline parsing until every link reference definition in the page is known. */
  deferInline(job: () => void): void;
  parseInline(lines: readonly SourceLine[], depth: number): ConversionInline[];
  /** Asset-table id for a local image path, as written in a directive argument. */
  registerImage(source: string, line: number): string | undefined;
  /** Resolve an include argument; local targets are checked for containment. */
  includeTarget(argument: string, line: number): IncludeTarget;
  /** Refuse a directive whose options cannot be read. */
  refuseOptions(detail: string, line: number): never;
}

const ATX_HEADING = /^(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/u;
const THEMATIC_BREAK = /^(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/u;
const SETEXT_UNDERLINE = /^(=+|-+)[ \t]*$/u;
const LIST_MARKER = /^([-+*]|(\d{1,9})([.)]))(?=[ \t]|$)/u;
const TARGET = /^\(([^()]+)\)=[ \t]*$/u;
const COMMENT = /^%(.*)$/u;
const FOOTNOTE_DEFINITION = /^\[\^([^\]\s]+)\]:[ \t]?(.*)$/u;
const LINK_DEFINITION =
  /^\[((?:[^\]\\]|\\.)+)\]:[ \t]*(<[^<>\n]*>|\S+)(?:[ \t]+("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\((?:[^()\\]|\\.)*\)))?[ \t]*$/u;
const DIRECTIVE_INFO = /^\{([^\s{}]+)\}(?:[ \t]+(.*))?$/u;
const TABLE_DELIMITER = /^\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/u;
const REMOTE = /^(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|\/\/)/u;

const HTML_BLOCK_TAGS =
  "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";
const HTML_ATTRIBUTE =
  "(?:\\s+[a-zA-Z_:][a-zA-Z0-9_.:-]*(?:\\s*=\\s*(?:[^\"'=<>\\u0060\\u0000-\\u0020]+|'[^']*'|\"[^\"]*\"))?)";

/** CommonMark HTML block kinds 1 to 7: start pattern and, for 1 to 5, the end pattern. */
const HTML_BLOCKS: ReadonlyArray<{ start: RegExp; end?: RegExp; interruptsParagraph: boolean }> = [
  {
    start: /^<(?:script|pre|style|textarea)(?:\s|>|$)/iu,
    end: /<\/(?:script|pre|style|textarea)>/iu,
    interruptsParagraph: true,
  },
  { start: /^<!--/u, end: /-->/u, interruptsParagraph: true },
  { start: /^<\?/u, end: /\?>/u, interruptsParagraph: true },
  { start: /^<![A-Za-z]/u, end: />/u, interruptsParagraph: true },
  { start: /^<!\[CDATA\[/u, end: /\]\]>/u, interruptsParagraph: true },
  {
    start: new RegExp(String.raw`^</?(?:${HTML_BLOCK_TAGS})(?:\s|/?>|$)`, "iu"),
    interruptsParagraph: true,
  },
  {
    start: new RegExp(
      String.raw`^(?:<[A-Za-z][A-Za-z0-9-]*${HTML_ATTRIBUTE}*\s*/?>|</[A-Za-z][A-Za-z0-9-]*\s*>)\s*$`,
      "u",
    ),
    interruptsParagraph: false,
  },
];

interface ListMarker {
  readonly ordered: boolean;
  readonly bullet: string;
  readonly start?: number;
  readonly contentIndent: number;
  readonly firstContent: string;
  readonly empty: boolean;
}

/** Text after up to three columns of indentation, or undefined when indented four or more. */
function unindented(text: string): string | undefined {
  const indent = indentOf(text);
  return indent > 3 ? undefined : stripIndent(text, indent);
}

function listMarker(text: string): ListMarker | undefined {
  const indent = indentOf(text);
  if (indent > 3) return undefined;
  const rest = stripIndent(text, indent);
  const match = LIST_MARKER.exec(rest);
  if (!match) return undefined;
  const marker = match[1]!;
  const markerEnd = indent + marker.length;
  const after = rest.slice(marker.length);
  let spaces = 0;
  for (const character of after) {
    if (character === " ") spaces += 1;
    else if (character === "\t") spaces += TAB_STOP - ((markerEnd + spaces) % TAB_STOP);
    else break;
  }
  const content = after.trimStart();
  const empty = content.length === 0;
  const ordered = match[2] !== undefined;
  const base = {
    ordered,
    bullet: ordered ? match[3]! : marker,
    ...(ordered ? { start: Number(match[2]) } : {}),
  };
  if (empty) return { ...base, contentIndent: markerEnd + 1, firstContent: "", empty };
  if (spaces >= 5) {
    return {
      ...base,
      contentIndent: markerEnd + 1,
      firstContent: " ".repeat(spaces - 1) + content,
      empty,
    };
  }
  return { ...base, contentIndent: markerEnd + spaces, firstContent: content, empty };
}

function htmlBlockKind(text: string): number | undefined {
  const rest = unindented(text);
  if (rest === undefined) return undefined;
  const index = HTML_BLOCKS.findIndex((kind) => kind.start.test(rest));
  return index < 0 ? undefined : index;
}

function splitTableRow(text: string): string[] {
  let row = text.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
  const cells: string[] = [];
  let current = "";
  for (let index = 0; index < row.length; index += 1) {
    const character = row[index]!;
    if (character === "\\" && row[index + 1] === "|") {
      current += "|";
      index += 1;
      continue;
    }
    if (character === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  cells.push(current.trim());
  return cells;
}

function alignmentOf(cell: string): TableColumnAlignment {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return "center";
  if (left) return "left";
  if (right) return "right";
  return "default";
}

function span(startLine: number, endLine: number): SourceSpan {
  return { startLine, endLine: Math.max(startLine, endLine) };
}

/** Whether a line starts a block that ends an open paragraph. */
function interruptsParagraph(text: string): boolean {
  if (isBlank(text)) return true;
  if (fenceOpening(text)) return true;
  const rest = unindented(text);
  if (rest === undefined) return false;
  if (ATX_HEADING.test(rest) || THEMATIC_BREAK.test(rest)) return true;
  if (rest.startsWith(">")) return true;
  if (TARGET.test(rest) || COMMENT.test(rest) || FOOTNOTE_DEFINITION.test(rest)) return true;
  const kind = htmlBlockKind(text);
  if (kind !== undefined && HTML_BLOCKS[kind]!.interruptsParagraph) return true;
  const marker = listMarker(text);
  if (marker && !marker.empty && (!marker.ordered || marker.start === 1)) return true;
  return false;
}

/**
 * Block parser for one container's lines. Containers (block quotes, list
 * items, footnotes, Markdown directive bodies) collect their own lines and
 * recurse with a fresh parser one level deeper, so every node keeps the
 * source lines of the page it came from.
 */
export class BlockParser {
  private index = 0;
  private readonly blocks: ConversionBlock[] = [];

  public constructor(
    private readonly lines: readonly SourceLine[],
    private readonly context: BlockContext,
    private readonly depth: number,
  ) {}

  public parse(): ConversionBlock[] {
    while (this.index < this.lines.length) {
      const line = this.lines[this.index]!;
      if (isBlank(line.text)) {
        this.index += 1;
        continue;
      }
      this.block(line);
    }
    return this.blocks;
  }

  private child(lines: readonly SourceLine[], line: number): ConversionBlock[] {
    this.context.enterBlock(this.depth + 1, line);
    return new BlockParser(lines, this.context, this.depth + 1).parse();
  }

  private inline(
    lines: readonly SourceLine[],
    assign: (children: ConversionInline[]) => void,
  ): void {
    const { depth } = this;
    this.context.deferInline(() => assign(this.context.parseInline(lines, depth)));
  }

  private block(line: SourceLine): void {
    const { text } = line;
    if (indentOf(text) >= 4) return this.indentedCode();
    const fence = fenceOpening(text);
    if (fence) return this.fenced(fence);
    const rest = unindented(text)!;
    const heading = ATX_HEADING.exec(rest);
    if (heading) return this.atxHeading(line, heading);
    if (THEMATIC_BREAK.test(rest)) {
      this.blocks.push({ kind: "thematicBreak", id: "", span: span(line.line, line.line) });
      this.index += 1;
      return;
    }
    if (rest.startsWith(">")) return this.blockquote();
    if (FOOTNOTE_DEFINITION.test(rest)) return this.footnoteDefinition();
    const marker = listMarker(text);
    if (marker) return this.list(marker);
    const htmlKind = htmlBlockKind(text);
    if (htmlKind !== undefined) return this.htmlBlock(htmlKind);
    if (COMMENT.test(rest)) return this.comment();
    const target = TARGET.exec(rest);
    if (target && target[1]!.trim().length > 0) {
      this.blocks.push({
        kind: "target",
        id: "",
        label: target[1]!.trim(),
        span: span(line.line, line.line),
      });
      this.index += 1;
      return;
    }
    if (this.table()) return;
    this.paragraph();
  }

  private indentedCode(): void {
    const start = this.index;
    let end = this.index;
    while (end < this.lines.length) {
      const { text } = this.lines[end]!;
      if (!isBlank(text) && indentOf(text) < 4) break;
      end += 1;
    }
    let last = end;
    while (last > start && isBlank(this.lines[last - 1]!.text)) last -= 1;
    const lines = this.lines.slice(start, last);
    this.blocks.push({
      kind: "codeBlock",
      id: "",
      value: lines.map((line) => stripIndent(line.text, 4)).join("\n"),
      options: { other: [] },
      span: span(lines[0]!.line, lines.at(-1)!.line),
    });
    this.index = end;
  }

  private fenced(fence: FenceOpening): void {
    const open = this.lines[this.index]!;
    const content: SourceLine[] = [];
    let cursor = this.index + 1;
    let closeLine: number | undefined;
    while (cursor < this.lines.length) {
      const line = this.lines[cursor]!;
      if (closesFence(line.text, fence.marker)) {
        closeLine = line.line;
        cursor += 1;
        break;
      }
      content.push(withText(line, stripIndent(line.text, fence.indent)));
      cursor += 1;
    }
    this.index = cursor;
    const where = span(open.line, closeLine ?? content.at(-1)?.line ?? open.line);
    const directive = DIRECTIVE_INFO.exec(fence.info);
    if (directive) {
      const argument = directive[2]?.trim();
      this.directive(directive[1]!.toLowerCase(), argument ? argument : undefined, content, where);
      return;
    }
    const info = unescapeString(fence.info);
    const [language, ...meta] = info.split(/[ \t]+/u).filter((part) => part.length > 0);
    this.blocks.push({
      kind: "codeBlock",
      id: "",
      ...(language !== undefined ? { language } : {}),
      ...(meta.length > 0 ? { meta: meta.join(" ") } : {}),
      value: content.map((line) => line.text).join("\n"),
      options: { other: [] },
      span: where,
    });
  }

  private atxHeading(line: SourceLine, match: RegExpExecArray): void {
    const content = (match[2] ?? "").replace(/(?:^|[ \t]+)#+[ \t]*$/u, "").trim();
    const node: HeadingNode = {
      kind: "heading",
      id: "",
      depth: match[1]!.length,
      children: [],
      span: span(line.line, line.line),
    };
    this.blocks.push(node);
    this.inline([withText(line, content)], (children) => {
      node.children = children;
    });
    this.index += 1;
  }

  /** Collect a container's lines: prefixed lines plus lazy paragraph continuations. */
  private collectContainer(
    stripPrefix: (line: SourceLine) => string | undefined,
    allowBlankContinuation: (next: SourceLine | undefined) => boolean,
  ): SourceLine[] {
    const collected: SourceLine[] = [];
    const fences = new FenceTracker();
    while (this.index < this.lines.length) {
      const line = this.lines[this.index]!;
      const stripped = stripPrefix(line);
      if (stripped !== undefined) {
        collected.push(withText(line, stripped));
        fences.observe(stripped);
        this.index += 1;
        continue;
      }
      if (isBlank(line.text)) {
        let next = this.index;
        while (next < this.lines.length && isBlank(this.lines[next]!.text)) next += 1;
        if (!allowBlankContinuation(this.lines[next])) break;
        for (; this.index < next; this.index += 1) {
          collected.push(withText(this.lines[this.index]!, ""));
        }
        continue;
      }
      const previous = collected.at(-1);
      const lazy =
        previous !== undefined &&
        !isBlank(previous.text) &&
        !fences.inFence &&
        !interruptsParagraph(line.text) &&
        listMarker(line.text) === undefined;
      if (!lazy) break;
      collected.push(line);
      this.index += 1;
    }
    return collected;
  }

  private nextNonBlank(from: number): SourceLine | undefined {
    for (let cursor = from; cursor < this.lines.length; cursor += 1) {
      if (!isBlank(this.lines[cursor]!.text)) return this.lines[cursor];
    }
    return undefined;
  }

  private blockquote(): void {
    const first = this.lines[this.index]!;
    const lines = this.collectContainer(
      (line) => {
        const rest = unindented(line.text);
        if (rest === undefined || !rest.startsWith(">")) return undefined;
        const after = rest.slice(1);
        return after.startsWith(" ")
          ? after.slice(1)
          : after.startsWith("\t")
            ? stripIndent(after, 1)
            : after;
      },
      () => false,
    );
    const children = this.child(lines, first.line);
    this.blocks.push({
      kind: "blockquote",
      id: "",
      children,
      span: span(first.line, lines.at(-1)?.line ?? first.line),
    });
  }

  private footnoteDefinition(): void {
    const first = this.lines[this.index]!;
    const match = FOOTNOTE_DEFINITION.exec(unindented(first.text)!)!;
    this.index += 1;
    const rest = this.collectContainer(
      (line) =>
        !isBlank(line.text) && indentOf(line.text) >= 4 ? stripIndent(line.text, 4) : undefined,
      (next) => next !== undefined && indentOf(next.text) >= 4,
    );
    const lines = [withText(first, match[2]!), ...rest];
    const children = this.child(lines, first.line);
    this.blocks.push({
      kind: "footnoteDefinition",
      id: "",
      label: match[1]!,
      children,
      span: span(first.line, lines.at(-1)!.line),
    });
  }

  private list(first: ListMarker): void {
    const items: ListItemNode[] = [];
    const startLine = this.lines[this.index]!.line;
    let endLine = startLine;
    while (this.index < this.lines.length) {
      const line = this.lines[this.index]!;
      const marker = listMarker(line.text);
      const rest = unindented(line.text);
      if (
        !marker ||
        marker.ordered !== first.ordered ||
        marker.bullet !== first.bullet ||
        (rest !== undefined && THEMATIC_BREAK.test(rest))
      ) {
        break;
      }
      this.index += 1;
      const { contentIndent } = marker;
      const continuation = this.collectContainer(
        (next) =>
          !isBlank(next.text) && indentOf(next.text) >= contentIndent
            ? stripIndent(next.text, contentIndent)
            : undefined,
        (next) => next !== undefined && indentOf(next.text) >= contentIndent,
      );
      const lines = [withText(line, marker.firstContent), ...continuation];
      while (lines.length > 1 && isBlank(lines.at(-1)!.text)) lines.pop();
      const children = this.child(lines, line.line);
      const itemEnd = lines.at(-1)!.line;
      items.push({ kind: "listItem", id: "", children, span: span(line.line, itemEnd) });
      endLine = itemEnd;
      const next = this.nextNonBlank(this.index);
      const nextMarker = next ? listMarker(next.text) : undefined;
      if (
        !nextMarker ||
        nextMarker.ordered !== first.ordered ||
        nextMarker.bullet !== first.bullet
      ) {
        break;
      }
      while (this.index < this.lines.length && isBlank(this.lines[this.index]!.text))
        this.index += 1;
    }
    this.blocks.push({
      kind: "list",
      id: "",
      ordered: first.ordered,
      ...(first.ordered && first.start !== undefined ? { start: first.start } : {}),
      items,
      span: span(startLine, endLine),
    });
  }

  private htmlBlock(kind: number): void {
    const { end } = HTML_BLOCKS[kind]!;
    const start = this.index;
    let cursor = this.index;
    while (cursor < this.lines.length) {
      const { text } = this.lines[cursor]!;
      if (end === undefined) {
        if (isBlank(text)) break;
      } else if (end.test(text)) {
        cursor += 1;
        break;
      }
      cursor += 1;
    }
    const lines = this.lines.slice(start, cursor);
    this.index = cursor;
    const value = lines.map((line) => line.text).join("\n");
    const where = span(lines[0]!.line, lines.at(-1)!.line);
    const comment = /^\s*<!--([\s\S]*?)-->\s*$/u.exec(value);
    if (comment && !comment[1]!.includes("-->")) {
      this.blocks.push({ kind: "comment", id: "", value: comment[1]!.trim(), span: where });
      return;
    }
    this.blocks.push({ kind: "html", id: "", value, span: where });
  }

  private comment(): void {
    const start = this.lines[this.index]!.line;
    const values: string[] = [];
    let endLine = start;
    while (this.index < this.lines.length) {
      const line = this.lines[this.index]!;
      const rest = unindented(line.text);
      const match = rest === undefined ? null : COMMENT.exec(rest);
      if (!match) break;
      values.push(match[1]!.startsWith(" ") ? match[1]!.slice(1) : match[1]!);
      endLine = line.line;
      this.index += 1;
    }
    this.blocks.push({
      kind: "comment",
      id: "",
      value: values.join("\n"),
      span: span(start, endLine),
    });
  }

  private table(): boolean {
    const header = this.lines[this.index]!;
    const delimiter = this.lines[this.index + 1];
    if (!delimiter || !header.text.includes("|")) return false;
    const delimiterText = unindented(delimiter.text);
    if (delimiterText === undefined || !TABLE_DELIMITER.test(delimiterText)) return false;
    if (!delimiterText.includes("|") && !header.text.trim().startsWith("|")) return false;
    const headerCells = splitTableRow(header.text);
    const alignments = splitTableRow(delimiterText).map(alignmentOf);
    if (headerCells.length !== alignments.length) return false;
    const row = (line: SourceLine): TableRow => ({
      cells: splitTableRow(line.text).map((cell): TableCell => {
        if (cell.length === 0) return { children: [] };
        const paragraph: ParagraphNode = {
          kind: "paragraph",
          id: "",
          children: [],
          span: span(line.line, line.line),
        };
        this.inline([withText(line, cell)], (children) => {
          paragraph.children = children;
        });
        return { children: [paragraph] };
      }),
    });
    const headerRows = [row(header)];
    const bodyRows: TableRow[] = [];
    this.index += 2;
    let endLine = delimiter.line;
    while (this.index < this.lines.length) {
      const line = this.lines[this.index]!;
      if (interruptsParagraph(line.text) || indentOf(line.text) >= 4) break;
      bodyRows.push(row(line));
      endLine = line.line;
      this.index += 1;
    }
    this.blocks.push({
      kind: "table",
      id: "",
      headerRows,
      bodyRows,
      alignments,
      span: span(header.line, endLine),
    });
    return true;
  }

  private paragraph(): void {
    const lines: SourceLine[] = [this.lines[this.index]!];
    this.index += 1;
    while (this.index < this.lines.length) {
      const line = this.lines[this.index]!;
      const rest = unindented(line.text);
      if (
        rest !== undefined &&
        SETEXT_UNDERLINE.test(rest) &&
        this.withoutDefinitions(lines).length > 0
      ) {
        const content = this.withoutDefinitions(lines);
        const node: HeadingNode = {
          kind: "heading",
          id: "",
          depth: rest.startsWith("=") ? 1 : 2,
          children: [],
          span: span(content[0]!.line, line.line),
        };
        this.blocks.push(node);
        this.inline(
          content.map((each) => withText(each, each.text.trim())),
          (children) => {
            node.children = children;
          },
        );
        this.index += 1;
        return;
      }
      if (interruptsParagraph(line.text)) break;
      lines.push(line);
      this.index += 1;
    }
    this.paragraphFrom(lines);
  }

  private withoutDefinitions(lines: readonly SourceLine[]): SourceLine[] {
    let start = 0;
    while (start < lines.length) {
      const rest = unindented(lines[start]!.text);
      const match = rest === undefined ? null : LINK_DEFINITION.exec(rest);
      if (!match || match[1]!.startsWith("^")) break;
      start += 1;
    }
    return lines.slice(start);
  }

  private paragraphFrom(lines: readonly SourceLine[]): void {
    let start = 0;
    while (start < lines.length) {
      const rest = unindented(lines[start]!.text);
      const match = rest === undefined ? null : LINK_DEFINITION.exec(rest);
      if (!match || match[1]!.startsWith("^")) break;
      const key = normalizeLinkLabel(match[1]!);
      if (key.length > 0 && !this.context.definitions.has(key)) {
        const destination = match[2]!;
        const url = unescapeString(
          destination.startsWith("<") ? destination.slice(1, -1) : destination,
        );
        const title = match[3] === undefined ? undefined : unescapeString(match[3].slice(1, -1));
        this.context.definitions.set(key, { url, ...(title !== undefined ? { title } : {}) });
      }
      start += 1;
    }
    const content = lines.slice(start);
    if (content.length === 0) return;
    const node: ParagraphNode = {
      kind: "paragraph",
      id: "",
      children: [],
      span: span(content[0]!.line, content.at(-1)!.line),
    };
    this.blocks.push(node);
    this.inline(
      content.map((line) => withText(line, line.text.trimStart())),
      (children) => {
        node.children = children;
      },
    );
  }

  private directive(
    name: string,
    argument: string | undefined,
    content: readonly SourceLine[],
    where: SourceSpan,
  ): void {
    let parts: ReturnType<typeof splitDirectiveContent>;
    try {
      parts = splitDirectiveContent(content);
    } catch (error) {
      const line = (error as { line?: number }).line ?? where.startLine;
      return this.context.refuseOptions(`{${name}}: ${(error as Error).message}`, line);
    }
    const options = new OptionSet(parts.options);
    switch (name) {
      case "code-block":
      case "code":
      case "sourcecode":
        this.blocks.push(this.codeDirective(argument, options, parts.body, where));
        return;
      case "image":
        this.blocks.push(this.imageNode(argument ?? "", options, where));
        return;
      case "figure":
        this.blocks.push(this.figure(argument ?? "", options, parts.body, where));
        return;
      case "math": {
        const label = options.take("label");
        const other = options.rest();
        const value = [argument, bodyText(parts.body)]
          .filter((part) => part !== undefined && part.length > 0)
          .join("\n");
        this.blocks.push({
          kind: "math",
          id: "",
          value,
          ...(label ? { label } : {}),
          ...(other.length > 0 ? { other } : {}),
          span: where,
        });
        return;
      }
      case "include":
      case "literalinclude":
      case "rli":
        this.blocks.push(this.include(name, argument ?? "", options, where));
        return;
      case "toctree":
        this.blocks.push(this.toctree(argument, parts.options, parts.body, where));
        return;
    }
    if (name === "raw" && (argument ?? "").toLowerCase().split(/\s+/u).includes("html")) {
      const extra = options.rest();
      if (extra.length > 0) {
        return this.context.refuseOptions(
          `{raw} html with option ${extra.map((option) => `:${option.name}:`).join(", ")} is not supported; the reader keeps raw HTML only from the directive body.`,
          where.startLine,
        );
      }
      this.blocks.push({ kind: "html", id: "", value: bodyText(parts.body), span: where });
      return;
    }
    const node: DirectiveNode = {
      kind: "directive",
      id: "",
      name,
      ...(argument !== undefined ? { argument } : {}),
      options: parts.options,
      body: { kind: "none" },
      span: where,
    };
    if (parts.body.some((line) => !isBlank(line.text))) {
      node.body = TEXT_BODY_DIRECTIVES.has(name)
        ? { kind: "text", value: bodyText(parts.body) }
        : { kind: "blocks", children: this.child(parts.body, where.startLine) };
    }
    this.blocks.push(node);
  }

  private codeDirective(
    argument: string | undefined,
    options: OptionSet,
    body: readonly SourceLine[],
    where: SourceSpan,
  ): CodeBlockNode {
    const [language, ...meta] = (argument ?? "").split(/[ \t]+/u).filter((part) => part.length > 0);
    const caption = options.take("caption");
    const emphasizeLines = options.takeTyped("emphasize-lines", parseLineRanges);
    const lineNumbers = options.take("linenos") !== undefined;
    const firstLineNumber = options.takeTyped("lineno-start", parsePositiveInteger);
    const name = options.take("name");
    return {
      kind: "codeBlock",
      id: "",
      ...(language !== undefined ? { language } : {}),
      ...(meta.length > 0 ? { meta: meta.join(" ") } : {}),
      value: bodyText(body),
      options: {
        ...(caption !== undefined ? { caption } : {}),
        ...(emphasizeLines !== undefined ? { emphasizeLines } : {}),
        ...(lineNumbers ? { lineNumbers } : {}),
        ...(firstLineNumber !== undefined ? { firstLineNumber } : {}),
        ...(name ? { name } : {}),
        other: options.rest(),
      },
      span: where,
    };
  }

  private imageNode(source: string, options: OptionSet, where: SourceSpan): ImageNode {
    const assetId = this.context.registerImage(source, where.startLine);
    const field = (name: string): Record<string, string> => {
      const value = options.take(name);
      return value !== undefined ? { [name]: value } : {};
    };
    return {
      kind: "image",
      id: "",
      ...(assetId !== undefined ? { assetId } : {}),
      source,
      options: {
        ...field("alt"),
        ...field("title"),
        ...field("width"),
        ...field("height"),
        ...field("align"),
        ...field("target"),
        other: options.rest(),
      },
      span: where,
    };
  }

  private figure(
    source: string,
    options: OptionSet,
    body: readonly SourceLine[],
    where: SourceSpan,
  ): FigureNode {
    const label = options.take("name");
    const image = this.imageNode(source, options, where);
    const children = body.some((line) => !isBlank(line.text))
      ? this.child(body, where.startLine)
      : [];
    const node: FigureNode = {
      kind: "figure",
      id: "",
      image,
      caption: [],
      legend: children,
      ...(label ? { label } : {}),
      span: where,
    };
    const first = children[0];
    if (first?.kind === "paragraph") {
      node.legend = children.slice(1);
      this.context.deferInline(() => {
        node.caption = first.children;
      });
    }
    return node;
  }

  private include(
    name: string,
    argument: string,
    options: OptionSet,
    where: SourceSpan,
  ): IncludeNode {
    const literalFlag = name === "include" && options.take("literal") !== undefined;
    const code = name === "include" ? options.take("code") : undefined;
    const mode: IncludeNode["mode"] =
      name === "include" && !literalFlag && code === undefined ? "markup" : "literal";
    const target = this.context.includeTarget(argument, where.startLine);
    const language = options.take("language") ?? (code ? code : undefined);
    const caption = options.take("caption");
    const emphasizeLines = options.takeTyped("emphasize-lines", parseLineRanges);
    const lines = options.takeTyped("lines", parseLineRanges);
    const pyobject = options.take("pyobject");
    const startAfter = options.take("start-after");
    const endBefore = options.take("end-before");
    return {
      kind: "include",
      id: "",
      mode,
      target,
      ...(language ? { language } : {}),
      ...(caption !== undefined ? { caption } : {}),
      ...(emphasizeLines !== undefined ? { emphasizeLines } : {}),
      ...(lines !== undefined ? { lines } : {}),
      ...(pyobject !== undefined ? { pyobject } : {}),
      ...(startAfter !== undefined ? { startAfter } : {}),
      ...(endBefore !== undefined ? { endBefore } : {}),
      other: options.rest(),
      span: where,
    };
  }

  private toctree(
    argument: string | undefined,
    options: DirectiveNode["options"],
    body: readonly SourceLine[],
    where: SourceSpan,
  ): DirectiveNode {
    const set = new OptionSet(options);
    const glob = set.has("glob");
    const caption = set.take("caption");
    const entries: ToctreeEntry[] = [];
    for (const line of body) {
      const entry = line.text.trim();
      if (entry.length === 0) continue;
      const at = span(line.line, line.line);
      const titled = /^(.+?)\s*<([^<>]+)>$/u.exec(entry);
      const title = titled ? titled[1]!.trim() : undefined;
      const reference = titled ? titled[2]!.trim() : entry;
      if (reference === "self") {
        entries.push({ kind: "self", ...(title ? { title } : {}), span: at });
      } else if (REMOTE.test(reference) || /^mailto:/iu.test(reference)) {
        entries.push({ kind: "url", url: reference, ...(title ? { title } : {}), span: at });
      } else if (glob && !titled && /[*?[]/u.test(reference)) {
        entries.push({ kind: "glob", pattern: reference, span: at });
      } else {
        entries.push({
          kind: "document",
          target: reference,
          ...(title ? { title } : {}),
          span: at,
        });
      }
    }
    return {
      kind: "directive",
      id: "",
      name: "toctree",
      ...(argument !== undefined ? { argument } : {}),
      options,
      body: {
        kind: "toctree",
        entries,
        ...(caption ? { caption } : {}),
        hidden: set.has("hidden"),
        glob,
      },
      span: where,
    };
  }
}

export function isRemoteReference(reference: string): boolean {
  return REMOTE.test(reference);
}
