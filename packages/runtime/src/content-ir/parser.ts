// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { canonicalDigest, sha256 } from "./canonical.js";
import { ContentIndexError } from "./contracts.js";
import type { CodeBlockShape, ContentFormat, DirectiveShape } from "./contracts.js";
import { compareText } from "../shared/primitives.js";

export interface ContentIrHeading {
  anchor: string;
  depth: number;
  line: number;
  endLine: number;
  id: string;
  textDigest: string;
}

export interface ContentIrLink {
  line: number;
  target: string;
  intent: "link" | "image";
  role?: "ref" | "doc";
}

export interface RstParsedDocument {
  sourcePath: string;
  id: string;
  format: "rst";
  byteLength: number;
  anchors: string[];
  frontmatter: [];
  directives: DirectiveShape[];
  codeBlocks: CodeBlockShape[];
  headings: ContentIrHeading[];
  links: ContentIrLink[];
  bodyDigest: string;
  headingsDigest: string;
  metadataDigest: string;
}

const SUPPORTED_DIRECTIVES = new Set([
  "code",
  "code-block",
  "include",
  "literalinclude",
  "toctree",
]);

/**
 * Parses the finite structural RST subset. This intentionally records shapes,
 * labels, and local references only; include and toctree execution belongs to
 * the Sphinx adapter rather than the Content IR.
 */
export function parseRstDocument(input: {
  sourcePath: string;
  contents: string;
  byteLength: number;
}): RstParsedDocument {
  const lines = input.contents.split("\n");
  const headings: Array<
    Omit<ContentIrHeading, "endLine" | "id" | "textDigest"> & { text: string }
  > = [];
  const labels = new Map<number, string>();
  const directives: DirectiveShape[] = [];
  const codeBlocks: CodeBlockShape[] = [];
  const links: ContentIrLink[] = [];
  const bodyLines = [...lines];
  const adornments = new Map<string, number>();

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const label = line.match(/^\s*\.\.\s+_([^:]+):\s*$/u);
    if (label) {
      const value = normalizeAnchor(label[1]!);
      if (!value) unsupported(input.sourcePath, index + 1, "empty explicit label");
      labels.set(index + 1, value);
      bodyLines[index] = "";
      continue;
    }
    if (/^\s*\.\.\s+_[^:]+\s*$/u.test(line)) {
      unsupported(input.sourcePath, index + 1, "malformed explicit label");
    }

    const directive = line.match(/^\s*\.\.\s+([A-Za-z][\w-]*)::(?:\s*(.*))?\s*$/u);
    if (directive) {
      const name = directive[1]!.toLowerCase();
      if (!SUPPORTED_DIRECTIVES.has(name))
        unsupported(input.sourcePath, index + 1, `directive ${name}`);
      directives.push({ name, line: index + 1 });
      bodyLines[index] = "";
      if (name === "code" || name === "code-block") {
        const end = indentedBlockEnd(lines, index + 1);
        codeBlocks.push({
          ...(directive[2]?.trim() ? { language: directive[2]!.trim() } : {}),
          startLine: index + 1,
          endLine: end,
        });
        // Directive bodies are literal content for structural indexing. In
        // particular, interpreted-text-looking source in a code example is
        // not a reference to resolve.
        index = end - 1;
      }
      continue;
    }
    if (/^\s*\.\.\s+[A-Za-z][\w-]*:/u.test(line)) {
      unsupported(input.sourcePath, index + 1, "malformed directive");
    }

    const underline = lines[index + 1] ?? "";
    if (line.trim() && isAdornment(underline)) {
      headings.push({
        anchor: "",
        depth: headingDepth(adornments, underline.trim()[0]!),
        line: index + 1,
        text: line.trim(),
      });
      bodyLines[index] = "";
      bodyLines[index + 1] = "";
      index += 1;
      continue;
    }
    if (
      isAdornment(line) &&
      (lines[index + 1] ?? "").trim() &&
      isSameAdornment(lines[index + 2] ?? "", line)
    ) {
      headings.push({
        anchor: "",
        depth: headingDepth(adornments, line.trim()[0]!),
        line: index + 2,
        text: (lines[index + 1] ?? "").trim(),
      });
      bodyLines[index] = "";
      bodyLines[index + 1] = "";
      bodyLines[index + 2] = "";
      index += 2;
      continue;
    }

    parseRoles(line, input.sourcePath, index + 1, links, "rst");
  }

  const documentId = `document:${sha256(`path:${input.sourcePath}`)}`;
  const anchors = new Map<string, number>();
  const consumedLabels = new Set<number>();
  const ordered = headings.sort((left, right) => left.line - right.line);
  const materialized: ContentIrHeading[] = ordered.map((heading, index) => {
    const labelLine = labels.has(heading.line - 1)
      ? heading.line - 1
      : labels.has(heading.line - 2) && !(lines[heading.line - 2] ?? "").trim()
        ? heading.line - 2
        : undefined;
    const explicit = labelLine === undefined ? undefined : labels.get(labelLine);
    if (labelLine !== undefined) consumedLabels.add(labelLine);
    const anchor =
      explicit ??
      addGeneratedAnchor(anchors, normalizeAnchor(heading.text), input.sourcePath, heading.line);
    if (explicit) assertNewAnchor(anchors, explicit, input.sourcePath, heading.line);
    return {
      anchor,
      depth: heading.depth,
      line: heading.line,
      endLine: (ordered[index + 1]?.line ?? lines.length + 1) - 1,
      id: `section:${sha256(`${documentId}\0${anchor}`)}`,
      textDigest: sha256(normalizeHeadingText(heading.text)),
    };
  });
  for (const [line, anchor] of labels) {
    if (!consumedLabels.has(line)) assertNewAnchor(anchors, anchor, input.sourcePath, line);
  }

  return {
    sourcePath: input.sourcePath,
    id: documentId,
    format: "rst",
    byteLength: input.byteLength,
    anchors: [...anchors.keys()].sort(compareText),
    frontmatter: [],
    directives,
    codeBlocks,
    headings: materialized,
    links,
    bodyDigest: sha256(bodyLines.map(normalizeBodyLine).join("\n")),
    headingsDigest: canonicalDigest({
      headings: materialized.map(({ anchor, depth, textDigest }) => ({
        anchor,
        depth,
        textDigest,
      })),
      anchors: [...anchors.keys()].sort(compareText),
    }),
    metadataDigest: canonicalDigest([]),
  };
}

/** Extracts the role and fenced-directive additions that V2 intentionally did not model. */
export function enrichMystV3<
  T extends {
    sourcePath: string;
    format: ContentFormat;
    links: ContentIrLink[];
    directives: DirectiveShape[];
    codeBlocks: CodeBlockShape[];
  },
>(document: T, contents: string): T {
  const lines = contents.split("\n");
  let mystSyntax = false;
  let markdownFence: { marker: string } | undefined;
  const directiveStack: string[] = [];
  let inHtmlComment = false;
  const start = frontmatterEnd(lines);
  for (let index = start; index < lines.length; index += 1) {
    const line = maskInlineCode(
      maskHtmlComments(
        lines[index] ?? "",
        () => inHtmlComment,
        (value) => {
          inHtmlComment = value;
        },
      ),
      { preserveMystRoles: true },
    );
    if (markdownFence) {
      if (
        new RegExp(
          `^\\s*${escapeRegExp(markdownFence.marker[0]!)}{${markdownFence.marker.length},}\\s*$`,
          "u",
        ).test(line)
      ) {
        markdownFence = undefined;
      }
      continue;
    }
    if (
      directiveStack.length > 0 &&
      closesDirective(line, directiveStack[directiveStack.length - 1]!)
    ) {
      directiveStack.pop();
      continue;
    }
    const directive = mystDirective(line);
    if (directive) {
      const { marker, name, argument } = directive;
      mystSyntax = true;
      const enclosing = directiveStack.at(-1);
      if (enclosing && marker[0] === enclosing[0] && marker.length >= enclosing.length) {
        unsupported(document.sourcePath, index + 1, "nested directive fence must be shorter");
      }
      if (!SUPPORTED_DIRECTIVES.has(name)) {
        unsupported(document.sourcePath, index + 1, `directive ${name}`);
      }
      if (!document.directives.some((item) => item.name === name && item.line === index + 1)) {
        document.directives.push({ name, line: index + 1 });
      }
      // The base Markdown pass sees a backtick/tilde directive fence as an
      // ordinary code fence. Directive syntax supersedes that provisional
      // shape in V3, including for non-literal directive bodies.
      document.codeBlocks = document.codeBlocks.filter((block) => block.startLine !== index + 1);
      if (name === "code" || name === "code-block") {
        const end = fencedDirectiveEnd(lines, index + 1, marker);
        if (end === undefined) {
          unsupported(document.sourcePath, index + 1, "unclosed fenced directive");
        }
        document.codeBlocks.push({
          ...(argument ? { language: argument } : {}),
          startLine: index + 1,
          endLine: end,
        });
        index = end - 1;
        continue;
      }
      directiveStack.push(marker);
      continue;
    }
    if (/^\s*:{3,}/u.test(line)) {
      unsupported(document.sourcePath, index + 1, "malformed fenced directive");
    }
    const fence = line.match(/^\s*(`{3,}|~{3,})/u);
    if (fence) {
      markdownFence = { marker: fence[1]! };
      continue;
    }
    const before = document.links.length;
    parseRoles(line, document.sourcePath, index + 1, document.links, "myst");
    if (document.links.length > before) mystSyntax = true;
  }
  if (directiveStack.length > 0)
    unsupported(document.sourcePath, lines.length, "unclosed fenced directive");
  if (mystSyntax && document.sourcePath.toLowerCase().endsWith(".md")) document.format = "myst";
  document.links.sort(
    (left, right) => left.line - right.line || compareText(left.target, right.target),
  );
  document.codeBlocks.sort((left, right) => left.startLine - right.startLine);
  return document;
}

function parseRoles(
  line: string,
  sourcePath: string,
  lineNumber: number,
  links: ContentIrLink[],
  syntax: "myst" | "rst",
): void {
  const known = syntax === "myst" ? /\{(ref|doc)\}`([^`]+)`/gu : /:(ref|doc):`([^`]+)`/gu;
  for (const match of line.matchAll(known)) {
    const target = roleTarget(match[2]!);
    const name = match[1]!;
    if (!target) unsupported(sourcePath, lineNumber, `empty ${name} role`);
    links.push({ line: lineNumber, target, intent: "link", role: name as "ref" | "doc" });
  }
  const remaining = line.replace(known, "");
  const role = syntax === "myst" ? /(?:\{[^}\s]+\}|:\w[\w-]*:)`/u : /:\w[\w-]*:`/u;
  if (role.test(remaining)) {
    unsupported(sourcePath, lineNumber, "unsupported interpreted-text role");
  }
  const malformed = syntax === "myst" ? /(?:\{[^}\s]+\}|:\w[\w-]*:)(?!`)/u : /:\w[\w-]*:(?!`)/u;
  if (malformed.test(remaining))
    unsupported(sourcePath, lineNumber, "malformed interpreted-text role");
}

function roleTarget(value: string): string {
  const explicit = value.match(/^.*?\s*<([^>]+)>\s*$/u);
  return (explicit?.[1] ?? value).trim();
}

function isAdornment(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length >= 3 && /^([=\-`:'"~^_*+#<>])\1*$/u.test(trimmed);
}

function isSameAdornment(value: string, other: string): boolean {
  return isAdornment(value) && value.trim()[0] === other.trim()[0];
}

function headingDepth(adornments: Map<string, number>, marker: string): number {
  const known = adornments.get(marker);
  if (known !== undefined) return known;
  const depth = adornments.size + 1;
  adornments.set(marker, depth);
  return depth;
}

function indentedBlockEnd(lines: string[], start: number): number {
  let end = start + 1;
  for (; end < lines.length; end += 1) {
    const line = lines[end] ?? "";
    if (line && !/^\s+/u.test(line)) break;
  }
  return Math.max(start + 1, end);
}

function fencedDirectiveEnd(lines: string[], start: number, marker: string): number | undefined {
  for (let index = start + 1; index < lines.length; index += 1) {
    if (closesDirective(lines[index] ?? "", marker)) {
      return index + 1;
    }
  }
  return undefined;
}

function mystDirective(
  line: string,
): { marker: string; name: string; argument?: string } | undefined {
  const match = line.match(/^\s*((?:`|~|:){3,})\{([A-Za-z][\w-]*)\}(?:\s+([^\s]+))?\s*$/u);
  if (!match) return undefined;
  const marker = match[1]!;
  if (!/^(?:`+|~+|:+)$/u.test(marker)) return undefined;
  return {
    marker,
    name: match[2]!.toLowerCase(),
    ...(match[3] ? { argument: match[3] } : {}),
  };
}

function closesDirective(line: string, marker: string): boolean {
  return new RegExp(`^\\s*${escapeRegExp(marker[0]!)}{${marker.length},}\\s*$`, "u").test(line);
}

function frontmatterEnd(lines: string[]): number {
  if ((lines[0] ?? "").trim() !== "---") return 0;
  const closing = lines.slice(1).findIndex((line) => line.trim() === "---");
  return closing < 0 ? 0 : closing + 2;
}

function maskHtmlComments(
  line: string,
  current: () => boolean,
  update: (value: boolean) => void,
): string {
  let masked = "";
  let cursor = 0;
  let active = current();
  while (cursor < line.length) {
    if (active) {
      const close = line.indexOf("-->", cursor);
      if (close < 0) {
        update(true);
        return `${masked}${" ".repeat(line.length - cursor)}`;
      }
      masked += " ".repeat(close + 3 - cursor);
      cursor = close + 3;
      active = false;
      continue;
    }
    const open = line.indexOf("<!--", cursor);
    if (open < 0) {
      masked += line.slice(cursor);
      break;
    }
    masked += line.slice(cursor, open);
    cursor = open;
    active = true;
  }
  update(active);
  return masked;
}

export function maskInlineCode(
  line: string,
  options: { preserveMystRoles?: boolean } = {},
): string {
  let masked = line;
  let cursor = 0;
  while (cursor < masked.length) {
    const start = masked.indexOf("`", cursor);
    if (start < 0) break;
    let endOfMarker = start;
    while (masked[endOfMarker] === "`") endOfMarker += 1;
    const marker = masked.slice(start, endOfMarker);
    if (
      options.preserveMystRoles &&
      /(?:\{(?:ref|doc)\}|:(?:ref|doc):)$/u.test(masked.slice(0, start))
    ) {
      // Leave the complete role intact. Advancing only past its opening
      // delimiter would let its closing delimiter pair with the next role's
      // opening delimiter and mask valid prose between them.
      const roleEnd = masked.indexOf(marker, endOfMarker);
      cursor = roleEnd < 0 ? endOfMarker : roleEnd + marker.length;
      continue;
    }
    const end = masked.indexOf(marker, endOfMarker);
    if (end < 0) break;
    masked = `${masked.slice(0, start)}${" ".repeat(end + marker.length - start)}${masked.slice(end + marker.length)}`;
    cursor = end + marker.length;
  }
  return masked;
}

function normalizeAnchor(value: string): string {
  return value
    .normalize("NFC")
    .toLowerCase()
    .replace(/<[^>]+>/gu, "")
    .replace(/[`*_~]/gu, "")
    .replace(/[^\p{Letter}\p{Number}\s_-]/gu, "")
    .trim()
    .replace(/[\s_]+/gu, "-")
    .replace(/-+/gu, "-");
}

function normalizeHeadingText(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim();
}

function normalizeBodyLine(line: string): string {
  return line.replace(/\s+$/u, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function addGeneratedAnchor(
  anchors: Map<string, number>,
  requested: string,
  path: string,
  line: number,
): string {
  if (!requested) unsupported(path, line, "empty heading anchor");
  let anchor = requested;
  let suffix = 1;
  while (anchors.has(anchor)) anchor = `${requested}-${suffix++}`;
  anchors.set(anchor, line);
  return anchor;
}

function assertNewAnchor(
  anchors: Map<string, number>,
  anchor: string,
  path: string,
  line: number,
): void {
  if (anchors.has(anchor)) unsupported(path, line, "duplicate explicit label");
  anchors.set(anchor, line);
}

function unsupported(path: string, line: number, detail: string): never {
  // hygiene: envelope - code-bearing ContentIndexError is rendered by the host boundary.
  throw new ContentIndexError(
    "unsupported-document-syntax",
    `Unsupported RST/MyST syntax in ${path} at line ${line}: ${detail}.`,
  );
}
