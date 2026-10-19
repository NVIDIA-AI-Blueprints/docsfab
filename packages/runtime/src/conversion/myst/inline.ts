// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ConversionInline,
  EmphasisNode,
  LinkNode,
  SourceSpan,
  StrongNode,
} from "../contracts.js";
import { ConversionContractError } from "../contracts.js";
import type { SourceLine } from "./lines.js";

/** A link reference definition, keyed by its normalized label. */
export interface LinkDefinition {
  readonly url: string;
  readonly title?: string;
}

export interface InlineContext {
  readonly definitions: ReadonlyMap<string, LinkDefinition>;
  /** Called for every inline container with its nesting depth below the enclosing block. */
  readonly enterInline: (depth: number, line: number) => void;
  /** Records a local image and returns its asset-table id; remote sources return undefined. */
  readonly registerImage: (source: string, line: number) => string | undefined;
  /** Refuses when a meaningful image title has no channel in the conversion IR. */
  readonly refuseImageTitle: (line: number) => never;
}

interface TextSlot {
  kind: "text";
  value: string;
  start: number;
  end: number;
}

interface NodeSlot {
  kind: "node";
  node: ConversionInline;
}

interface DelimiterSlot {
  kind: "delimiter";
  character: "*" | "_";
  count: number;
  originalCount: number;
  start: number;
  canOpen: boolean;
  canClose: boolean;
  previousDelimiter?: DelimiterSlot | undefined;
  nextDelimiter?: DelimiterSlot | undefined;
}

interface BracketSlot {
  kind: "bracket";
  image: boolean;
  start: number;
  active: boolean;
  /** Delimiter stack top when the bracket opened; emphasis inside the link stops there. */
  delimiterBottom: DelimiterSlot | undefined;
}

type SlotValue = TextSlot | NodeSlot | DelimiterSlot | BracketSlot;

interface Slot {
  value: SlotValue;
  previous: Slot | undefined;
  next: Slot | undefined;
}

const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/u;
const UNICODE_WHITESPACE = /\s/u;
const UNICODE_PUNCTUATION = /[\p{P}\p{S}]/u;
// Sticky patterns match at `lastIndex` without copying the rest of the text.
const ROLE_OPENING = /\{([A-Za-z][\w:.+-]*)\}(`+)/uy;
const SUBSTITUTION = /\{\{([^{}\n]*)\}\}/uy;
const URI_AUTOLINK = /<([A-Za-z][A-Za-z0-9.+-]{1,31}:[^<>\u0000- ]*)>/uy;
const EMAIL_AUTOLINK =
  /<([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)>/uy;
const ATTRIBUTE =
  "(?:\\s+[a-zA-Z_:][a-zA-Z0-9_.:-]*(?:\\s*=\\s*(?:[^\"'=<>\\u0060\\u0000-\\u0020]+|'[^']*'|\"[^\"]*\"))?)";
const HTML_TAG = new RegExp(
  String.raw`<[A-Za-z][A-Za-z0-9-]*${ATTRIBUTE}*\s*/?>|</[A-Za-z][A-Za-z0-9-]*\s*>|<!---?>`,
  "uy",
);
/** Raw HTML whose end is a fixed string: comments, processing instructions, CDATA, declarations. */
const HTML_SPANS: ReadonlyArray<{ open: RegExp; close: string }> = [
  { open: /<!--/uy, close: "-->" },
  { open: /<\?/uy, close: "?>" },
  { open: /<!\[CDATA\[/uy, close: "]]>" },
  { open: /<![A-Za-z]/uy, close: ">" },
];
const FOOTNOTE_REFERENCE = /\[\^([^\]\s]+)\]/uy;
const ENTITY = /&(?:#[xX]([0-9a-fA-F]{1,6})|#([0-9]{1,7})|([A-Za-z][A-Za-z0-9]{1,31}));/uy;
const NAMED_ENTITIES: Readonly<Record<string, string>> = Object.freeze({
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  trade: "™",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  larr: "←",
  rarr: "→",
  times: "×",
});

/** Lower-cased, whitespace-collapsed link label, as CommonMark matches references. */
export function normalizeLinkLabel(label: string): string {
  return label.trim().replace(/\s+/gu, " ").toLowerCase();
}

function matchAt(pattern: RegExp, text: string, index: number): RegExpExecArray | null {
  pattern.lastIndex = index;
  return pattern.exec(text);
}

/** Decode one entity at `index`; unknown named entities stay literal. */
function decodeEntity(text: string, index: number): { value: string; length: number } | undefined {
  const match = matchAt(ENTITY, text, index);
  if (!match) return undefined;
  if (match[1] !== undefined || match[2] !== undefined) {
    const code = match[1] !== undefined ? Number.parseInt(match[1], 16) : Number(match[2]);
    const valid = code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
    return { value: valid ? String.fromCodePoint(code) : "�", length: match[0].length };
  }
  const named = NAMED_ENTITIES[match[3]!];
  return named === undefined ? undefined : { value: named, length: match[0].length };
}

/** Resolve backslash escapes and entities in a link destination or title. */
export function unescapeString(text: string): string {
  let result = "";
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (character === "\\" && ASCII_PUNCTUATION.test(text[index + 1] ?? "")) {
      result += text[index + 1];
      index += 1;
      continue;
    }
    if (character === "&") {
      const entity = decodeEntity(text, index);
      if (entity) {
        result += entity.value;
        index += entity.length - 1;
        continue;
      }
    }
    result += character;
  }
  return result;
}

/** Parse a link destination and optional title starting at `position` (after `(`). */
export function parseLinkTail(
  text: string,
  position: number,
): { url: string; title?: string; end: number } | undefined {
  let index = skipSpace(text, position);
  let url: string;
  if (text[index] === "<") {
    const close = findUnescaped(text, ">", index + 1);
    if (close < 0) return undefined;
    const raw = text.slice(index + 1, close);
    if (/[\n<]/u.test(raw.replaceAll("\\<", ""))) return undefined;
    url = unescapeString(raw);
    index = close + 1;
  } else {
    let depth = 0;
    const start = index;
    while (index < text.length) {
      const character = text[index]!;
      if (character === "\\" && ASCII_PUNCTUATION.test(text[index + 1] ?? "")) {
        index += 2;
        continue;
      }
      if (/[\u0000- \u007f]/u.test(character)) break;
      if (character === "(") depth += 1;
      if (character === ")") {
        if (depth === 0) break;
        depth -= 1;
      }
      index += 1;
    }
    if (depth !== 0) return undefined;
    url = unescapeString(text.slice(start, index));
  }
  const afterUrl = index;
  index = skipSpace(text, index);
  let title: string | undefined;
  const opener = text[index];
  if (index > afterUrl && (opener === '"' || opener === "'" || opener === "(")) {
    const closer = opener === "(" ? ")" : opener;
    const close = findUnescaped(text, closer, index + 1);
    if (close < 0) return undefined;
    title = unescapeString(text.slice(index + 1, close));
    index = skipSpace(text, close + 1);
  }
  if (text[index] !== ")") return undefined;
  return { url, ...(title !== undefined ? { title } : {}), end: index + 1 };
}

function skipSpace(text: string, index: number): number {
  let cursor = index;
  while (cursor < text.length && /[ \t\n]/u.test(text[cursor]!)) cursor += 1;
  return cursor;
}

function findUnescaped(text: string, character: string, from: number): number {
  for (let index = from; index < text.length; index += 1) {
    if (text[index] === "\\") {
      index += 1;
      continue;
    }
    if (text[index] === character) return index;
  }
  return -1;
}

/** Split a role's content into its `Display <target>` parts. */
export function roleParts(content: string): { display?: string; target: string } {
  const match = /^([\s\S]*?)\s*<([^<>]+)>$/u.exec(content);
  if (!match) return { target: content };
  const display = match[1]!.trim();
  return display.length > 0 ? { display, target: match[2]! } : { target: match[2]! };
}

/** Plain text of inline nodes, used for image alt text and label titles. */
export function plainText(nodes: readonly ConversionInline[]): string {
  let text = "";
  for (const node of nodes) {
    switch (node.kind) {
      case "text":
      case "inlineCode":
      case "inlineMath":
        text += node.value;
        break;
      case "emphasis":
      case "strong":
      case "link":
        text += plainText(node.children);
        break;
      case "inlineImage":
        text += node.alt ?? "";
        break;
      case "role":
        text += node.display ?? node.target ?? node.content;
        break;
      case "lineBreak":
        text += "\n";
        break;
      case "substitutionReference":
        text += `{{${node.name}}}`;
        break;
      case "footnoteReference":
      case "inlineHtml":
        break;
    }
  }
  return text;
}

/**
 * Inline parser for one block's text: CommonMark code spans, escapes,
 * entities, autolinks, raw HTML, links and images (inline and reference),
 * emphasis by the delimiter-run algorithm, and hard breaks, plus MyST roles
 * and substitution references. Every node carries the source lines it spans.
 */
export class InlineParser {
  private readonly text: string;
  private readonly lineStarts: number[] = [];
  private readonly lineNumbers: number[] = [];
  private head: Slot | undefined;
  private tail: Slot | undefined;
  private delimiterTop: DelimiterSlot | undefined;
  private delimiterBottom: DelimiterSlot | undefined;
  private readonly slotOf = new Map<DelimiterSlot | BracketSlot, Slot>();
  private brackets: BracketSlot[] = [];
  private readonly depths = new WeakMap<object, number>();
  /** Per closing string or backtick run length, the offset after which no closer exists. */
  private readonly noCloserAfter = new Map<string, number>();

  public constructor(
    lines: readonly SourceLine[],
    private readonly context: InlineContext,
  ) {
    let offset = 0;
    const parts: string[] = [];
    lines.forEach((line, index) => {
      this.lineStarts.push(offset);
      this.lineNumbers.push(line.line);
      const text = index === lines.length - 1 ? line.text.trimEnd() : line.text;
      parts.push(text);
      offset += text.length + 1;
    });
    this.text = parts.join("\n");
  }

  public parse(): ConversionInline[] {
    const { text } = this;
    let index = 0;
    let textStart = 0;
    let pending = "";
    const flush = (end: number): void => {
      if (pending.length > 0) this.append({ kind: "text", value: pending, start: textStart, end });
      pending = "";
    };
    const startText = (at: number): void => {
      if (pending.length === 0) textStart = at;
    };
    while (index < text.length) {
      const character = text[index]!;
      const rest = text.slice(index, index + 2);
      if (character === "\\") {
        const next = text[index + 1];
        if (next === "\n") {
          flush(index);
          this.appendNode({ kind: "lineBreak", id: "", span: this.span(index, index + 1) });
          index += 2;
          index = this.skipLeadingSpace(index);
          continue;
        }
        if (next !== undefined && ASCII_PUNCTUATION.test(next)) {
          startText(index);
          pending += next;
          index += 2;
          continue;
        }
        startText(index);
        pending += character;
        index += 1;
        continue;
      }
      if (character === "\n") {
        let trailing = 0;
        while (pending[pending.length - 1 - trailing] === " ") trailing += 1;
        if (trailing > 0) pending = pending.slice(0, pending.length - trailing);
        if (trailing >= 2) {
          flush(index - trailing);
          this.appendNode({ kind: "lineBreak", id: "", span: this.span(index, index + 1) });
        } else {
          startText(index);
          pending += "\n";
          // Pending text never spans a line, so finding trailing spaces stays linear.
          flush(index + 1);
        }
        index = this.skipLeadingSpace(index + 1);
        continue;
      }
      if (character === "`") {
        flush(index);
        const consumed = this.codeSpan(index);
        if (consumed !== undefined) {
          index = consumed;
          continue;
        }
        const run = "`".repeat(this.runLength(index, "`"));
        startText(index);
        pending += run;
        index += run.length;
        continue;
      }
      if (character === "{") {
        flush(index);
        const consumed = this.roleOrSubstitution(index);
        if (consumed !== undefined) {
          index = consumed;
          continue;
        }
      }
      if (character === "<") {
        flush(index);
        const consumed = this.autolinkOrHtml(index);
        if (consumed !== undefined) {
          index = consumed;
          continue;
        }
      }
      if (character === "&") {
        const entity = decodeEntity(text, index);
        if (entity) {
          startText(index);
          pending += entity.value;
          index += entity.length;
          continue;
        }
      }
      if (rest === "![") {
        flush(index);
        this.openBracket(index, true);
        index += 2;
        continue;
      }
      if (character === "[") {
        const footnote = matchAt(FOOTNOTE_REFERENCE, text, index);
        if (footnote && text[index + footnote[0].length] !== ":") {
          flush(index);
          this.appendNode({
            kind: "footnoteReference",
            id: "",
            label: footnote[1]!,
            span: this.span(index, index + footnote[0].length),
          });
          index += footnote[0].length;
          continue;
        }
        flush(index);
        this.openBracket(index, false);
        index += 1;
        continue;
      }
      if (character === "]") {
        flush(index);
        const consumed = this.closeBracket(index);
        if (consumed !== undefined) {
          index = consumed;
          continue;
        }
        this.append({ kind: "text", value: "]", start: index, end: index + 1 });
        index += 1;
        continue;
      }
      if (character === "*" || character === "_") {
        flush(index);
        index = this.delimiterRun(index, character);
        continue;
      }
      startText(index);
      pending += character;
      index += 1;
    }
    flush(text.length);
    this.processEmphasis(undefined);
    return this.collect(this.head, undefined);
  }

  private skipLeadingSpace(index: number): number {
    let cursor = index;
    while (this.text[cursor] === " " || this.text[cursor] === "\t") cursor += 1;
    return cursor;
  }

  private lineAt(offset: number): number {
    let low = 0;
    let high = this.lineStarts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (this.lineStarts[middle]! <= offset) low = middle;
      else high = middle - 1;
    }
    return this.lineNumbers[low] ?? this.lineNumbers[0] ?? 1;
  }

  private span(start: number, end: number): SourceSpan {
    const startLine = this.lineAt(start);
    return { startLine, endLine: Math.max(startLine, this.lineAt(Math.max(start, end - 1))) };
  }

  private append(value: SlotValue): Slot {
    const slot: Slot = { value, previous: this.tail, next: undefined };
    if (this.tail) this.tail.next = slot;
    else this.head = slot;
    this.tail = slot;
    if (value.kind === "delimiter" || value.kind === "bracket") this.slotOf.set(value, slot);
    return slot;
  }

  private appendNode(node: ConversionInline): void {
    this.append({ kind: "node", node });
  }

  private remove(slot: Slot): void {
    if (slot.previous) slot.previous.next = slot.next;
    else this.head = slot.next;
    if (slot.next) slot.next.previous = slot.previous;
    else this.tail = slot.previous;
  }

  private runLength(index: number, character: string): number {
    let end = index;
    while (this.text[end] === character) end += 1;
    return end - index;
  }

  /** Offset of `closer` at or after `from`, remembering a failed search so it is not repeated. */
  private findCloser(closer: string, from: number): number {
    const exhausted = this.noCloserAfter.get(closer);
    if (exhausted !== undefined && from >= exhausted) return -1;
    const found = this.text.indexOf(closer, from);
    if (found < 0) this.noCloserAfter.set(closer, Math.min(exhausted ?? from, from));
    return found;
  }

  private codeSpan(index: number): number | undefined {
    const { text } = this;
    const run = "`".repeat(this.runLength(index, "`"));
    let cursor = index + run.length;
    while (cursor < text.length) {
      const close = this.findCloser(run, cursor);
      if (close < 0) return undefined;
      let closeEnd = close + run.length;
      if (text[closeEnd] === "`") {
        while (text[closeEnd] === "`") closeEnd += 1;
        cursor = closeEnd;
        continue;
      }
      if (text[close - 1] === "`") {
        cursor = closeEnd;
        continue;
      }
      let value = text.slice(index + run.length, close).replaceAll("\n", " ");
      if (value.length > 1 && value.startsWith(" ") && value.endsWith(" ") && value.trim() !== "") {
        value = value.slice(1, -1);
      }
      this.appendNode({ kind: "inlineCode", id: "", value, span: this.span(index, closeEnd) });
      return closeEnd;
    }
    return undefined;
  }

  private roleOrSubstitution(index: number): number | undefined {
    const substitution = matchAt(SUBSTITUTION, this.text, index);
    if (substitution) {
      const name = substitution[1]!.trim();
      if (name.length === 0) return undefined;
      const end = index + substitution[0].length;
      this.appendNode({
        kind: "substitutionReference",
        id: "",
        name,
        span: this.span(index, end),
      });
      return end;
    }
    const role = matchAt(ROLE_OPENING, this.text, index);
    if (!role) return undefined;
    const ticks = role[2]!;
    const contentStart = index + role[0].length;
    let cursor = contentStart;
    while (cursor < this.text.length) {
      const close = this.findCloser(ticks, cursor);
      if (close < 0) return undefined;
      let closeEnd = close + ticks.length;
      if (this.text[closeEnd] === "`") {
        while (this.text[closeEnd] === "`") closeEnd += 1;
        cursor = closeEnd;
        continue;
      }
      const content = this.text.slice(contentStart, close).replaceAll("\n", " ");
      const parts = roleParts(content);
      this.appendNode({
        kind: "role",
        id: "",
        name: role[1]!.toLowerCase(),
        content,
        ...(parts.display !== undefined ? { display: parts.display } : {}),
        target: parts.target,
        span: this.span(index, closeEnd),
      });
      return closeEnd;
    }
    return undefined;
  }

  private autolinkOrHtml(index: number): number | undefined {
    const { text } = this;
    const uriMatch = matchAt(URI_AUTOLINK, text, index);
    const emailMatch = uriMatch ? undefined : matchAt(EMAIL_AUTOLINK, text, index);
    const uri = uriMatch ?? emailMatch;
    if (uri) {
      const end = index + uri[0].length;
      const label = uri[1]!;
      const url = emailMatch ? `mailto:${label}` : label;
      const span = this.span(index, end);
      const link: LinkNode = {
        kind: "link",
        id: "",
        url,
        children: [{ kind: "text", id: "", value: label, span }],
        span,
      };
      this.enterContainer(link, [], index);
      this.appendNode(link);
      return end;
    }
    let end: number | undefined;
    const tag = matchAt(HTML_TAG, text, index);
    if (tag) end = index + tag[0].length;
    for (const { open, close } of HTML_SPANS) {
      if (end !== undefined) break;
      const opening = matchAt(open, text, index);
      if (!opening) continue;
      const closeAt = this.findCloser(close, index + opening[0].length);
      if (closeAt < 0) return undefined;
      end = closeAt + close.length;
    }
    if (end === undefined) return undefined;
    this.appendNode({
      kind: "inlineHtml",
      id: "",
      value: text.slice(index, end),
      span: this.span(index, end),
    });
    return end;
  }

  private delimiterRun(index: number, character: "*" | "_"): number {
    const { text } = this;
    let end = index;
    while (text[end] === character) end += 1;
    const before = index === 0 ? "\n" : text[index - 1]!;
    const after = end >= text.length ? "\n" : text[end]!;
    const afterSpace = UNICODE_WHITESPACE.test(after);
    const beforeSpace = UNICODE_WHITESPACE.test(before);
    const afterPunctuation = UNICODE_PUNCTUATION.test(after);
    const beforePunctuation = UNICODE_PUNCTUATION.test(before);
    const leftFlanking = !afterSpace && (!afterPunctuation || beforeSpace || beforePunctuation);
    const rightFlanking = !beforeSpace && (!beforePunctuation || afterSpace || afterPunctuation);
    const canOpen =
      character === "*" ? leftFlanking : leftFlanking && (!rightFlanking || beforePunctuation);
    const canClose =
      character === "*" ? rightFlanking : rightFlanking && (!leftFlanking || afterPunctuation);
    const count = end - index;
    const delimiter: DelimiterSlot = {
      kind: "delimiter",
      character,
      count,
      originalCount: count,
      start: index,
      canOpen,
      canClose,
      previousDelimiter: this.delimiterTop,
      nextDelimiter: undefined,
    };
    if (this.delimiterTop) this.delimiterTop.nextDelimiter = delimiter;
    else this.delimiterBottom = delimiter;
    this.delimiterTop = delimiter;
    this.append(delimiter);
    return end;
  }

  private openBracket(index: number, image: boolean): void {
    const bracket: BracketSlot = {
      kind: "bracket",
      image,
      start: index,
      active: true,
      delimiterBottom: this.delimiterTop,
    };
    this.brackets.push(bracket);
    this.append(bracket);
  }

  private closeBracket(index: number): number | undefined {
    const opener = this.brackets.at(-1);
    if (!opener) return undefined;
    const openerSlot = this.slotOf.get(opener)!;
    if (!opener.active) {
      this.brackets.pop();
      this.toText(openerSlot);
      return undefined;
    }
    const labelStart = opener.start + (opener.image ? 2 : 1);
    const label = this.text.slice(labelStart, index);
    const target = this.linkTarget(index + 1, label);
    if (!target) {
      this.brackets.pop();
      this.toText(openerSlot);
      return undefined;
    }
    this.processEmphasis(opener.delimiterBottom);
    const children = this.collect(openerSlot.next, undefined);
    let cursor = openerSlot.next;
    while (cursor) {
      const next = cursor.next;
      this.remove(cursor);
      cursor = next;
    }
    this.remove(openerSlot);
    this.brackets.pop();
    const span = this.span(opener.start, target.end);
    if (opener.image) {
      if (target.title !== undefined) this.context.refuseImageTitle(span.startLine);
      const alt = plainText(children);
      const assetId = this.context.registerImage(target.url, span.startLine);
      this.appendNode({
        kind: "inlineImage",
        id: "",
        source: target.url,
        ...(assetId !== undefined ? { assetId } : {}),
        ...(alt.length > 0 ? { alt } : {}),
        span,
      });
    } else {
      const link: LinkNode = {
        kind: "link",
        id: "",
        url: target.url,
        ...(target.title !== undefined ? { title: target.title } : {}),
        children,
        span,
      };
      this.enterContainer(link, children, opener.start);
      this.appendNode(link);
      // Links do not nest: every earlier `[` stops opening a link. Brackets
      // below an inactive one were deactivated by the link that closed it.
      for (let cursor = this.brackets.length - 1; cursor >= 0; cursor -= 1) {
        const earlier = this.brackets[cursor]!;
        if (earlier.image) continue;
        if (!earlier.active) break;
        earlier.active = false;
      }
    }
    return target.end;
  }

  private linkTarget(
    position: number,
    label: string,
  ): { url: string; title?: string; end: number } | undefined {
    const { text } = this;
    if (text[position] === "(") {
      const inline = parseLinkTail(text, position + 1);
      if (inline) return inline;
    }
    if (text[position] === "[") {
      const close = findUnescaped(text, "]", position + 1);
      if (close >= 0) {
        const reference = text.slice(position + 1, close);
        const key = normalizeLinkLabel(reference.length > 0 ? reference : label);
        const definition = this.context.definitions.get(key);
        if (definition) return { ...definition, end: close + 1 };
        if (reference.length > 0) return undefined;
      }
    }
    const definition = this.context.definitions.get(normalizeLinkLabel(label));
    return definition ? { ...definition, end: position } : undefined;
  }

  /** Turn an unmatched bracket or delimiter into literal text. */
  private toText(slot: Slot): void {
    const { value } = slot;
    if (value.kind === "bracket") {
      slot.value = {
        kind: "text",
        value: value.image ? "![" : "[",
        start: value.start,
        end: value.start + (value.image ? 2 : 1),
      };
      this.slotOf.delete(value);
    }
  }

  private removeDelimiter(delimiter: DelimiterSlot): void {
    if (delimiter.previousDelimiter)
      delimiter.previousDelimiter.nextDelimiter = delimiter.nextDelimiter;
    else this.delimiterBottom = delimiter.nextDelimiter;
    if (delimiter.nextDelimiter)
      delimiter.nextDelimiter.previousDelimiter = delimiter.previousDelimiter;
    else this.delimiterTop = delimiter.previousDelimiter;
  }

  /** The CommonMark "process emphasis" procedure over delimiters above `bottom`. */
  private processEmphasis(bottom: DelimiterSlot | undefined): void {
    let closer = bottom === undefined ? this.delimiterBottom : bottom.nextDelimiter;
    const openersBottom = new Map<string, DelimiterSlot | undefined>();
    while (closer) {
      if (!closer.canClose) {
        closer = closer.nextDelimiter;
        continue;
      }
      const bottomKey = `${closer.character}${closer.canOpen ? 1 : 0}${closer.originalCount % 3}`;
      const limit = openersBottom.has(bottomKey) ? openersBottom.get(bottomKey) : bottom;
      let opener = closer.previousDelimiter;
      let found: DelimiterSlot | undefined;
      while (opener && opener !== bottom && opener !== limit) {
        const oddMatch =
          (opener.canClose || closer.canOpen) &&
          (opener.originalCount + closer.originalCount) % 3 === 0 &&
          !(opener.originalCount % 3 === 0 && closer.originalCount % 3 === 0);
        if (opener.character === closer.character && opener.canOpen && !oddMatch) {
          found = opener;
          break;
        }
        opener = opener.previousDelimiter;
      }
      if (!found) {
        openersBottom.set(bottomKey, closer.previousDelimiter);
        const next: DelimiterSlot | undefined = closer.nextDelimiter;
        if (!closer.canOpen) this.removeDelimiter(closer);
        closer = next;
        continue;
      }
      closer = this.wrapEmphasis(found, closer);
    }
    let cursor = bottom === undefined ? this.delimiterBottom : bottom.nextDelimiter;
    while (cursor) {
      const next: DelimiterSlot | undefined = cursor.nextDelimiter;
      this.removeDelimiter(cursor);
      cursor = next;
    }
  }

  /** Wrap the slots between a matched opener and closer; returns the next closer to examine. */
  private wrapEmphasis(opener: DelimiterSlot, closer: DelimiterSlot): DelimiterSlot | undefined {
    const strong = opener.count >= 2 && closer.count >= 2;
    const used = strong ? 2 : 1;
    opener.count -= used;
    closer.count -= used;
    const openerSlot = this.slotOf.get(opener)!;
    const closerSlot = this.slotOf.get(closer)!;
    const start = opener.start + opener.count;
    const end = closer.start + used;
    closer.start += used;
    const children = this.collect(openerSlot.next, closerSlot);
    let cursor = openerSlot.next;
    while (cursor && cursor !== closerSlot) {
      const next = cursor.next;
      this.remove(cursor);
      cursor = next;
    }
    let between = opener.nextDelimiter;
    while (between && between !== closer) {
      const next = between.nextDelimiter;
      this.removeDelimiter(between);
      between = next;
    }
    const node: EmphasisNode | StrongNode = {
      kind: strong ? "strong" : "emphasis",
      id: "",
      children,
      span: this.span(start, end),
    };
    this.enterContainer(node, children, start);
    const nodeSlot: Slot = {
      value: { kind: "node", node },
      previous: openerSlot,
      next: closerSlot,
    };
    openerSlot.next = nodeSlot;
    closerSlot.previous = nodeSlot;
    if (opener.count === 0) {
      this.removeDelimiter(opener);
      this.remove(openerSlot);
    }
    if (closer.count === 0) {
      const next = closer.nextDelimiter;
      this.removeDelimiter(closer);
      this.remove(closerSlot);
      return next;
    }
    return closer;
  }

  private enterContainer(
    node: object,
    children: readonly ConversionInline[],
    offset: number,
  ): void {
    let depth = 1;
    for (const child of children) depth = Math.max(depth, (this.depths.get(child) ?? 0) + 1);
    this.depths.set(node, depth);
    this.context.enterInline(depth, this.lineAt(offset));
  }

  /** Materialize slots from `from` up to (not including) `until`, merging adjacent text. */
  private collect(from: Slot | undefined, until: Slot | undefined): ConversionInline[] {
    const nodes: ConversionInline[] = [];
    let text: { value: string; start: number; end: number } | undefined;
    const flushText = (): void => {
      if (text && text.value.length > 0) {
        nodes.push({
          kind: "text",
          id: "",
          value: text.value,
          span: this.span(text.start, text.end),
        });
      }
      text = undefined;
    };
    const addText = (value: string, start: number, end: number): void => {
      if (text) {
        text.value += value;
        text.end = end;
      } else {
        text = { value, start, end };
      }
    };
    for (let slot = from; slot && slot !== until; slot = slot.next) {
      const { value } = slot;
      switch (value.kind) {
        case "text":
          addText(value.value, value.start, value.end);
          break;
        case "delimiter":
          if (value.count > 0) {
            addText(value.character.repeat(value.count), value.start, value.start + value.count);
          }
          break;
        case "bracket":
          addText(value.image ? "![" : "[", value.start, value.start + (value.image ? 2 : 1));
          break;
        case "node":
          flushText();
          nodes.push(value.node);
          break;
      }
    }
    flushText();
    return nodes;
  }
}
