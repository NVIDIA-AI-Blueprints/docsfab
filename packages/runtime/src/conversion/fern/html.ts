// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { parseExpression } from "@babel/parser";

import { mdxComment, normalizeNewlines, templateLiteralExpression } from "./escape.js";

/**
 * How raw HTML reaches a Fern page. HTML that is already valid, inert JSX is
 * kept as written; anything else is wrapped so the browser parses it as HTML,
 * which keeps it exact at the cost of readability.
 */
export type HtmlForm = "comment" | "style" | "verbatim" | "wrapped";

const COMMENT = /^\s*<!--((?:(?!-->)[\s\S])*)-->\s*$/u;
const STYLE = /^\s*<style(\s[^>]*)?>((?:(?!<\/style>)[\s\S])*)<\/style>\s*$/iu;
/** Elements whose text MDX would reflow or reinterpret. */
const RAW_TEXT_ELEMENTS = new Set(["pre", "code", "script", "style", "textarea"]);
/** Characters in element text that Markdown inside JSX would read as syntax. */
const MARKDOWN_SENSITIVE_TEXT = /[`*_[\]~$\\|]/u;
const LINE_START_SENSITIVE = /^\s*(?:[#>+=-]|[0-9]+[.)])/mu;

type SyntaxNode = { type: string } & Record<string, unknown>;

function isSyntaxNode(value: unknown): value is SyntaxNode {
  return (
    typeof value === "object" && value !== null && typeof (value as SyntaxNode).type === "string"
  );
}

function children(node: SyntaxNode): SyntaxNode[] {
  const found: SyntaxNode[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "loc" || key === "extra") continue;
    if (Array.isArray(value)) found.push(...value.filter(isSyntaxNode));
    else if (isSyntaxNode(value)) found.push(value);
  }
  return found;
}

function inertJsx(root: SyntaxNode): boolean {
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop() as SyntaxNode;
    switch (node.type) {
      case "JSXExpressionContainer":
      case "JSXSpreadAttribute":
      case "JSXSpreadChild":
      case "JSXMemberExpression":
      case "JSXNamespacedName":
        return false;
      case "JSXOpeningElement": {
        const name = node.name as SyntaxNode;
        const tag = typeof name.name === "string" ? name.name : "";
        if (!/^[a-z]/u.test(tag) || RAW_TEXT_ELEMENTS.has(tag)) return false;
        break;
      }
      case "JSXAttribute": {
        const name = node.name as SyntaxNode;
        const attribute = typeof name.name === "string" ? name.name.toLowerCase() : "";
        if (attribute === "style" || attribute.startsWith("on")) return false;
        break;
      }
      case "JSXText": {
        const value = typeof node.value === "string" ? node.value : "";
        if (MARKDOWN_SENSITIVE_TEXT.test(value) || LINE_START_SENSITIVE.test(value)) return false;
        break;
      }
      default:
        break;
    }
    pending.push(...children(node));
  }
  return true;
}

function parsesAsInertJsx(value: string): boolean {
  if (/\n[ \t]*\n/u.test(value)) return false;
  let expression: SyntaxNode;
  try {
    expression = parseExpression(`<>${value}</>`, { plugins: ["jsx"] }) as unknown as SyntaxNode;
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
  return expression.type === "JSXFragment" && inertJsx(expression);
}

function styleAttributesParse(attributes: string): boolean {
  try {
    parseExpression(`<style${attributes}></style>`, { plugins: ["jsx"] });
    return true;
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
}

export function classifyHtml(value: string): HtmlForm {
  if (COMMENT.test(value)) return "comment";
  const style = STYLE.exec(value);
  if (style !== null && styleAttributesParse(style[1] ?? "")) return "style";
  return parsesAsInertJsx(value) ? "verbatim" : "wrapped";
}

/** Render raw HTML for an MDX page as a block or inside a paragraph. */
export function renderHtml(
  value: string,
  placement: "block" | "inline",
): {
  text: string;
  form: HtmlForm;
} {
  const html = normalizeNewlines(value);
  const form = classifyHtml(html);
  switch (form) {
    case "comment":
      return { text: mdxComment(COMMENT.exec(html)?.[1] ?? ""), form };
    case "style": {
      const [, attributes = "", body = ""] = STYLE.exec(html) ?? [];
      return { text: `<style${attributes}>${templateLiteralExpression(body)}</style>`, form };
    }
    case "verbatim":
      return { text: placement === "block" ? html.trim() : html, form };
    case "wrapped": {
      const element = placement === "block" ? "div" : "span";
      return {
        text: `<${element} dangerouslySetInnerHTML={{ __html: ${JSON.stringify(html)} }} />`,
        form,
      };
    }
  }
}
