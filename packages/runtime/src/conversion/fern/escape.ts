// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * MDX-safe serialization for Fern pages. Text escaping lives only here, and
 * code content never passes through it: code fences, code spans, math, and
 * JavaScript string expressions carry their content unchanged.
 */

/** How a run of text sits in the page. `line` and `cell` text cannot hold a line break. */
export type TextMode = "flow" | "line" | "cell";

export interface TextPosition {
  /** The text starts a line, so block markers at its start would take effect. */
  lineStart: boolean;
  mode: TextMode;
}

const ASCII_PUNCTUATION = /^[!-/:-@[-`{-~]$/u;
const ALPHANUMERIC = /^[\p{L}\p{N}]$/u;
const WHITESPACE = /^\s$/u;
/** A character reference, or the start of one that the next inline could complete. */
const CHARACTER_REFERENCE = /^&(?:#[0-9]*|#[xX][0-9a-fA-F]*|[A-Za-z][A-Za-z0-9]*)?(?:;|$)/u;
const ORDERED_LIST_MARKER = /^[0-9]+[.)]/u;
const MDX_ESM_BLOCK = /^(?:import|export)(?=$|[\s{(])/u;

/** Characters that start Markdown or MDX syntax anywhere in text. */
const ALWAYS_ESCAPED: Readonly<Record<string, string>> = Object.freeze({
  "<": "&lt;",
  "{": "\\{",
  "}": "\\}",
  "*": "\\*",
  "`": "\\`",
  "[": "\\[",
  "]": "\\]",
  "~": "\\~",
  $: "\\$",
});

/** Characters that start a block only at the beginning of a line. */
const LINE_START_ESCAPED = new Set([">", "#", "-", "+", "="]);

export function normalizeNewlines(value: string): string {
  return value.replace(/\r\n?/gu, "\n");
}

function isAsciiPunctuation(char: string | undefined): boolean {
  return char !== undefined && ASCII_PUNCTUATION.test(char);
}

/**
 * Escape decoded text so Markdown and MDX read it back as the same text. An
 * underscore is escaped only where it could open emphasis; every other
 * delimiter is escaped wherever it appears.
 */
export function escapeMdxText(value: string, position: TextPosition): string {
  const text = normalizeNewlines(value);
  let out = "";
  let lineStart = position.lineStart;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string;
    const previous = text[index - 1];
    const next = text[index + 1];
    if (char === "\n") {
      if (position.mode === "flow") {
        out += "\n";
        lineStart = true;
      } else {
        out += " ";
      }
      continue;
    }
    if (lineStart && (char === " " || char === "\t")) {
      out += char;
      continue;
    }
    const atLineStart = lineStart;
    lineStart = false;
    const fixed = ALWAYS_ESCAPED[char];
    if (fixed !== undefined) {
      out += fixed;
    } else if (
      atLineStart &&
      position.mode === "flow" &&
      (char === "i" || char === "e") &&
      MDX_ESM_BLOCK.test(text.slice(index))
    ) {
      out += `&#${char.charCodeAt(0)};`;
    } else if (char === "\\") {
      out += next === undefined || next === "\n" || isAsciiPunctuation(next) ? "\\\\" : "\\";
    } else if (char === "&") {
      out += CHARACTER_REFERENCE.test(text.slice(index)) ? "&amp;" : "&";
    } else if (char === "!" && next === undefined) {
      out += "\\!";
    } else if (char === "_") {
      const openerPossible =
        (previous === undefined || !ALPHANUMERIC.test(previous)) &&
        (next === undefined || !WHITESPACE.test(next));
      out += openerPossible ? "\\_" : "_";
    } else if (char === "|" && position.mode === "cell") {
      out += "\\|";
    } else if (atLineStart && LINE_START_ESCAPED.has(char)) {
      out += `\\${char}`;
    } else if (atLineStart && ORDERED_LIST_MARKER.test(text.slice(index))) {
      const marker = ORDERED_LIST_MARKER.exec(text.slice(index))?.[0] ?? char;
      out += `${marker.slice(0, -1)}\\${marker.slice(-1)}`;
      index += marker.length - 1;
    } else {
      out += char;
    }
  }
  return out;
}

/** A trailing `#` run in an ATX heading is a closing sequence; escape its first mark. */
export function escapeHeadingTail(content: string): string {
  return /(^|[^\\#])#+$/u.test(content) ? content.replace(/#(#*)$/u, "\\#$1") : content;
}

/** Whitespace runs become one space; attribute values and code spans are single-line. */
export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

const PLAIN_ATTRIBUTE = /^[^"&\p{Cc}\u2028\u2029]*$/u;

/** One JSX attribute. Values a JSX string cannot hold exactly become a string expression. */
export function jsxAttribute(name: string, value: string): string {
  return PLAIN_ATTRIBUTE.test(value) ? `${name}="${value}"` : `${name}={${JSON.stringify(value)}}`;
}

/** `{"..."}`: a JavaScript string expression that carries code or HTML unchanged. */
export function jsonExpression(value: string): string {
  return `{${JSON.stringify(value)}}`;
}

/** A template-literal expression, the form MDX pages use for `<style>` bodies. */
export function templateLiteralExpression(value: string): string {
  const body = value.replace(/\\/gu, "\\\\").replace(/`/gu, "\\`").replace(/\$\{/gu, "\\${");
  return `{\`${body}\`}`;
}

/** An MDX comment. A comment terminator in the body gets a zero-width space so it cannot end the comment early. */
export function mdxComment(body: string): string {
  return `{/*${body.replaceAll("*/", "*\u200b/")}*/}`;
}

function longestRun(value: string, char: string): number {
  let longest = 0;
  let current = 0;
  for (const each of value) {
    current = each === char ? current + 1 : 0;
    if (current > longest) longest = current;
  }
  return longest;
}

const MINIMUM_FENCE = "```";

/**
 * A fenced code block. The fence is longer than any backtick run in the code;
 * an info string that holds a backtick switches to a tilde fence.
 */
export function codeFence(value: string, info: string): string {
  const code = normalizeNewlines(value);
  const mark = info.includes("`") ? "~" : "`";
  const length = Math.max(MINIMUM_FENCE.length, longestRun(code, mark) + 1);
  const fence = mark.repeat(length);
  const body = code === "" || code.endsWith("\n") ? code : `${code}\n`;
  return `${fence}${info}\n${body}${fence}`;
}

/** A code span. Line breaks become spaces, as CommonMark renders them. */
export function inlineCodeSpan(value: string): string {
  const code = normalizeNewlines(value).replace(/\n/gu, " ");
  if (code === "") return "<code />";
  let length = 1;
  while (new RegExp(`(^|[^\`])\`{${length}}([^\`]|$)`, "u").test(code)) length += 1;
  const fence = "`".repeat(length);
  const pad =
    code.startsWith("`") ||
    code.endsWith("`") ||
    (code.startsWith(" ") && code.endsWith(" ") && code.trim() !== "");
  return pad ? `${fence} ${code} ${fence}` : `${fence}${code}${fence}`;
}

/** Percent-encode the characters that end or split a Markdown link destination. */
export function encodeLinkDestination(url: string): string {
  return url.replace(/[\s()<>\\{}|`]/gu, (char) => {
    const encoded = encodeURIComponent(char);
    return encoded === char ? `%${char.charCodeAt(0).toString(16).toUpperCase()}` : encoded;
  });
}

export function linkTitle(title: string): string {
  const escaped = collapseWhitespace(title)
    .replace(/["\\{}]/gu, "\\$&")
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;");
  return `"${escaped}"`;
}

const YAML_UNSAFE_PRINTABLE = /[\u007f-\u009f\u2028\u2029\ufeff]/gu;

/** A YAML double-quoted scalar; JSON escapes are a subset of YAML's. */
export function yamlDoubleQuoted(value: string): string {
  return JSON.stringify(value).replace(
    YAML_UNSAFE_PRINTABLE,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

const YAML_PLAIN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const YAML_RESERVED = /^(?:true|false|yes|no|on|off|y|n|null|~)$/iu;
const YAML_NUMERIC_LIKE = /^[0-9][A-Za-z0-9._+-]*$/u;

/** A plain YAML scalar when it cannot read as another type; otherwise double-quoted. */
export function yamlScalar(value: string): string {
  return YAML_PLAIN.test(value) && !YAML_RESERVED.test(value) && !YAML_NUMERIC_LIKE.test(value)
    ? value
    : yamlDoubleQuoted(value);
}

/** HTML text escaping for content that is wrapped as raw HTML. */
export function escapeHtmlText(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}
