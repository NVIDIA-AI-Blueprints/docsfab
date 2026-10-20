// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { parseExpression } from "@babel/parser";

import { FERN_BUILT_IN_COMPONENTS } from "./types.js";

/**
 * An independent MDX safety check of emitted page text. It shares no code
 * with the emitter's escaping, so an escaping defect shows up here as well.
 */
export type MdxSafetyIssueCode =
  | "newline-policy"
  | "frontmatter-unclosed"
  | "fence-unclosed"
  | "math-unclosed"
  | "html-comment"
  | "bare-angle-bracket"
  | "bare-brace"
  | "expression-unclosed"
  | "jsx-parse-failed"
  | "component-not-built-in"
  | "tag-unbalanced"
  | "esm-block";

export interface MdxSafetyIssue {
  code: MdxSafetyIssueCode;
  /** One-based line in the page text. */
  line: number;
  detail: string;
}

const BUILT_IN: ReadonlySet<string> = new Set(FERN_BUILT_IN_COMPONENTS);
const CONTAINER_PREFIX = /^(?:[ \t]*(?:>|[-+*]|[0-9]+[.)])(?=[ \t]|$))*[ \t]*/u;
const FENCE_OPEN = /^(`{3,}|~{3,})(.*)$/u;
const TAG_NAME = /^[A-Za-z][A-Za-z0-9.:-]*/u;
const ATTRIBUTE_NAME = /^[^\s=/>"'{}]+/u;
const ESM_BLOCK = /^(?:import|export)(?=$|[\s{(])/u;

/** JSX accepts the fragment as written. */
export function jsxFragmentParses(fragment: string): boolean {
  try {
    parseExpression(`<>${fragment}</>`, { plugins: ["jsx"] });
    return true;
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
}

/** Blank out frontmatter, fenced code, and display math, keeping line numbers. */
function proseLines(lines: readonly string[], issues: MdxSafetyIssue[]): string[] {
  const prose = [...lines];
  let index = 0;
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    if (end < 0) {
      issues.push({ code: "frontmatter-unclosed", line: 1, detail: "No closing --- line." });
      return prose.map(() => "");
    }
    for (; index <= end; index += 1) prose[index] = "";
  }
  let fence: { mark: string; length: number; line: number } | undefined;
  let mathLine: number | undefined;
  for (; index < lines.length; index += 1) {
    const content = (lines[index] as string).replace(CONTAINER_PREFIX, "");
    if (fence !== undefined) {
      prose[index] = "";
      const close = /^(`+|~+)[ \t]*$/u.exec(content);
      if (close?.[1]?.[0] === fence.mark && close[1].length >= fence.length) fence = undefined;
      continue;
    }
    if (mathLine !== undefined) {
      prose[index] = "";
      if (content.trimEnd() === "$$") mathLine = undefined;
      continue;
    }
    const open = FENCE_OPEN.exec(content);
    if (open?.[1] !== undefined && !(open[1][0] === "`" && open[2]?.includes("`"))) {
      fence = { mark: open[1][0] as string, length: open[1].length, line: index + 1 };
      prose[index] = "";
      continue;
    }
    if (content.trimEnd() === "$$") {
      mathLine = index + 1;
      prose[index] = "";
    }
  }
  if (fence !== undefined) {
    issues.push({ code: "fence-unclosed", line: fence.line, detail: "Code fence never closes." });
  }
  if (mathLine !== undefined) {
    issues.push({ code: "math-unclosed", line: mathLine, detail: "Display math never closes." });
  }
  return prose;
}

/** End index (exclusive) of a balanced `{...}` JavaScript expression, or -1. */
function expressionEnd(text: string, start: number): number {
  let depth = 0;
  let index = start;
  while (index < text.length) {
    const char = text[index] as string;
    if (char === '"' || char === "'" || char === "`") {
      index += 1;
      while (index < text.length && text[index] !== char) {
        index += text[index] === "\\" ? 2 : 1;
      }
    } else if (char === "/" && text[index + 1] === "*") {
      const close = text.indexOf("*/", index + 2);
      if (close < 0) return -1;
      index = close + 1;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
    index += 1;
  }
  return -1;
}

interface ScannedTag {
  name: string;
  kind: "open" | "close" | "self-closing";
  end: number;
  source: string;
}

/** Scan one JSX tag starting at `<`; undefined when the text is not a tag. */
function scanTag(text: string, start: number): ScannedTag | undefined {
  let index = start + 1;
  const closing = text[index] === "/";
  if (closing) index += 1;
  const name = TAG_NAME.exec(text.slice(index))?.[0];
  if (name === undefined) return undefined;
  index += name.length;
  for (;;) {
    while (index < text.length && /\s/u.test(text[index] as string)) index += 1;
    if (text.startsWith("/>", index) && !closing) {
      return { name, kind: "self-closing", end: index + 2, source: text.slice(start, index + 2) };
    }
    if (text[index] === ">") {
      const kind = closing ? "close" : "open";
      return { name, kind, end: index + 1, source: text.slice(start, index + 1) };
    }
    if (closing) return undefined;
    const attribute = ATTRIBUTE_NAME.exec(text.slice(index))?.[0];
    if (attribute === undefined) return undefined;
    index += attribute.length;
    if (text[index] !== "=") continue;
    index += 1;
    const quote = text[index];
    if (quote === '"' || quote === "'") {
      const close = text.indexOf(quote, index + 1);
      if (close < 0) return undefined;
      index = close + 1;
    } else if (quote === "{") {
      const end = expressionEnd(text, index);
      if (end < 0) return undefined;
      index = end;
    } else {
      return undefined;
    }
  }
}

/** One-based line of a text offset, by binary search over line starts. */
function lineLocator(text: string): (index: number) => number {
  const starts = [0];
  for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", at + 1)) starts.push(at + 1);
  return (index) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if ((starts[middle] as number) <= index) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };
}

/** Index after a matching delimiter run within the same paragraph, or -1. */
function spanEnd(text: string, start: number, delimiter: string): number {
  let length = 0;
  while (text[start + length] === delimiter) length += 1;
  const paragraphEnd = text.indexOf("\n\n", start);
  const limit = paragraphEnd < 0 ? text.length : paragraphEnd;
  for (let index = start + length; index < limit; index += 1) {
    if (text[index] !== delimiter) continue;
    let run = 0;
    while (text[index + run] === delimiter) run += 1;
    if (run === length) return index + run;
    index += run - 1;
  }
  return -1;
}

/**
 * Check emitted Fern page text: one trailing newline, no stray `<`, `{`, or
 * `}` outside code and math, only built-in components, balanced tags, and
 * JSX that `@babel/parser` accepts.
 */
export function checkFernMdx(page: string): MdxSafetyIssue[] {
  const issues: MdxSafetyIssue[] = [];
  if (page.includes("\r") || !page.endsWith("\n") || page.endsWith("\n\n")) {
    issues.push({
      code: "newline-policy",
      line: 1,
      detail: "Pages use LF line endings and end with exactly one newline.",
    });
  }
  const text = proseLines(page.split("\n"), issues).join("\n");
  const lineOf = lineLocator(text);
  for (const [lineIndex, raw] of text.split("\n").entries()) {
    const content = raw.replace(CONTAINER_PREFIX, "");
    if (ESM_BLOCK.test(content)) {
      issues.push({ code: "esm-block", line: lineIndex + 1, detail: content.trim() });
    }
  }
  const stack: Array<{ name: string; line: number }> = [];
  let childExpressionAt = -1;
  let childExpressionStyleOnly = false;
  let index = 0;
  while (index < text.length) {
    const char = text[index] as string;
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === "`" || char === "$") {
      const end = spanEnd(text, index, char);
      if (end > 0) {
        index = end;
        continue;
      }
      while (text[index] === char) index += 1;
      continue;
    }
    if (char === "{") {
      const end = expressionEnd(text, index);
      const source = end < 0 ? "" : text.slice(index, end);
      if (end < 0) {
        issues.push({ code: "expression-unclosed", line: lineOf(index), detail: "{" });
        index += 1;
        continue;
      }
      const comment = /^\{\s*\/\*[\s\S]*\*\/\s*\}$/u.test(source);
      if (!comment && (index !== childExpressionAt || !childExpressionStyleOnly)) {
        issues.push({ code: "bare-brace", line: lineOf(index), detail: source });
      } else if (
        !jsxFragmentParses(source) ||
        (index === childExpressionAt && !styleExpressionIsLiteral(source))
      ) {
        issues.push({ code: "jsx-parse-failed", line: lineOf(index), detail: source });
      }
      index = end;
      continue;
    }
    if (char === "}") {
      issues.push({ code: "bare-brace", line: lineOf(index), detail: "}" });
      index += 1;
      continue;
    }
    if (char === "<") {
      if (text.startsWith("<!--", index)) {
        issues.push({ code: "html-comment", line: lineOf(index), detail: "<!--" });
        index += 1;
        continue;
      }
      const tag = scanTag(text, index);
      if (tag === undefined) {
        issues.push({
          code: "bare-angle-bracket",
          line: lineOf(index),
          detail: text.slice(
            index,
            text.indexOf("\n", index) < 0 ? undefined : text.indexOf("\n", index),
          ),
        });
        index += 1;
        continue;
      }
      const line = lineOf(index);
      const custom =
        /[.:]/u.test(tag.name) || (/^[A-Z]/u.test(tag.name) && !BUILT_IN.has(tag.name));
      if (custom && tag.kind !== "close") {
        issues.push({ code: "component-not-built-in", line, detail: tag.name });
      }
      if (tag.kind === "close") {
        const open = stack.pop();
        if (open?.name !== tag.name) {
          issues.push({
            code: "tag-unbalanced",
            line,
            detail: `</${tag.name}> closes ${open === undefined ? "nothing" : `<${open.name}>`}.`,
          });
        }
      } else {
        const fragment = tag.kind === "open" ? `${tag.source}</${tag.name}>` : tag.source;
        if (!jsxFragmentParses(fragment)) {
          issues.push({ code: "jsx-parse-failed", line, detail: tag.source });
        }
        if (tag.kind === "open") stack.push({ name: tag.name, line });
      }
      index = tag.end;
      childExpressionAt = tag.kind === "open" ? tag.end : -1;
      childExpressionStyleOnly = tag.kind === "open" && tag.name === "style";
      continue;
    }
    index += 1;
  }
  for (const open of stack.reverse()) {
    issues.push({
      code: "tag-unbalanced",
      line: open.line,
      detail: `<${open.name}> never closes.`,
    });
  }
  return issues;
}

function styleExpressionIsLiteral(source: string): boolean {
  try {
    const expression = parseExpression(source.slice(1, -1), { plugins: ["jsx"] });
    return (
      expression.type === "StringLiteral" ||
      (expression.type === "TemplateLiteral" && expression.expressions.length === 0)
    );
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
}
