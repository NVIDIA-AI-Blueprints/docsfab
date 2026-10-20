// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  CONSTRUCT_RULE_REGISTRY,
  buildConstructRuleIndex,
  type ConversionBlock,
  type ConversionInline,
  type ConversionIrV1,
} from "../src/conversion/index.js";
import {
  checkFernMdx,
  codeFence,
  emitFernPage,
  escapeMdxText,
  inlineCodeSpan,
  jsxFragmentParses,
  type TextMode,
} from "../src/conversion/fern/index.js";

/** Deterministic pseudo-random generator so property cases replay exactly. */
function generator(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

const HAZARDS = [
  ..."<>{}[]()*_`~$\\&#|!-+=.:;\"' \n\t",
  "1.",
  "&lt;",
  "&#123;",
  "<4",
  "{/*",
  "*/",
  "```",
];
const PLAIN = [..."abcXYZ09é"];
const CASES = 400;
const MAX_TOKENS = 24;

function randomText(next: () => number): string {
  const length = Math.floor(next() * MAX_TOKENS);
  let text = "";
  for (let index = 0; index < length; index += 1) {
    const pool = next() < 0.6 ? HAZARDS : PLAIN;
    text += pool[Math.floor(next() * pool.length)];
  }
  return text;
}

/** CommonMark text decoding: backslash escapes of ASCII punctuation and character references. */
function decodeMarkdownText(text: string): string {
  return text.replace(
    /\\([!-/:-@[-`{-~])|&(lt|gt|amp|quot);|&#([0-9]+);/gu,
    (_, escaped, named, code) => {
      if (escaped !== undefined) return escaped;
      if (named !== undefined) return { lt: "<", gt: ">", amp: "&", quot: '"' }[named as "lt"];
      return String.fromCodePoint(Number(code));
    },
  );
}

/** Characters that start inline syntax and so must never appear unescaped in text. */
function activeCharacters(escaped: string): string[] {
  return [...escaped.replace(/\\[!-/:-@[-`{-~]/gu, "")].filter((char) =>
    "<{}*`[]~$".includes(char),
  );
}

const span = { startLine: 1, endLine: 1 };
let counter = 0;
const nextId = (): string => {
  counter += 1;
  return `n${counter}`;
};
const text = (value: string): ConversionInline => ({ id: nextId(), kind: "text", value, span });
const paragraph = (...children: ConversionInline[]): ConversionBlock => ({
  id: nextId(),
  kind: "paragraph",
  children,
  span,
});
const callout = (
  name: string,
  children: ConversionBlock[],
  argument?: string,
): ConversionBlock => ({
  id: nextId(),
  kind: "directive",
  name,
  ...(argument === undefined ? {} : { argument }),
  options: [],
  body: { kind: "blocks", children },
  span,
});

function page(children: ConversionBlock[]): string {
  const ir: ConversionIrV1 = {
    schemaVersion: 1,
    source: { generator: "sphinx", root: "docs", repositoryRevision: "0", extensionModules: [] },
    documents: [
      { id: "page", sourcePath: "docs/page.md", format: "myst", frontmatter: {}, children },
    ],
    navigation: { entries: [] },
    labels: [],
    routes: [],
    assets: [],
    substitutions: [],
    dropLedger: [],
  };
  const result = emitFernPage({
    ir,
    documentId: "page",
    rules: buildConstructRuleIndex(CONSTRUCT_RULE_REGISTRY),
  });
  if (result.status !== "emitted") throw new Error(JSON.stringify(result.refusals));
  return result.text;
}

describe("MDX-safe text escaping", () => {
  const modes: TextMode[] = ["flow", "line", "cell"];

  it("round-trips arbitrary text through CommonMark decoding", () => {
    const next = generator(7);
    for (let index = 0; index < CASES; index += 1) {
      const value = randomText(next);
      const mode = modes[index % modes.length] as TextMode;
      const escaped = escapeMdxText(value, { lineStart: next() < 0.5, mode });
      const expected = mode === "flow" ? value : value.replace(/\n/gu, " ");
      expect(decodeMarkdownText(escaped), JSON.stringify(value)).toBe(expected);
      expect(activeCharacters(escaped), JSON.stringify(value)).toEqual([]);
    }
  });

  it("escapes the MDX openers and bare less-than before a digit", () => {
    const flow = { lineStart: false, mode: "flow" } as const;
    expect(escapeMdxText("a <4 and {b} </Note>", flow)).toBe("a &lt;4 and \\{b\\} &lt;/Note>");
    expect(escapeMdxText("# not a heading", { lineStart: true, mode: "flow" })).toBe(
      "\\# not a heading",
    );
    expect(escapeMdxText("1. not a list", { lineStart: true, mode: "flow" })).toBe(
      "1\\. not a list",
    );
    expect(escapeMdxText("snake_case and _emph_", flow)).toBe("snake_case and \\_emph_");
    expect(escapeMdxText("a|b", { lineStart: false, mode: "cell" })).toBe("a\\|b");
  });

  it("never escapes code content", () => {
    const next = generator(11);
    for (let index = 0; index < CASES; index += 1) {
      const value = randomText(next);
      const fenced = codeFence(value, "text");
      const body = fenced.slice(fenced.indexOf("\n") + 1, fenced.lastIndexOf("\n"));
      expect(body, JSON.stringify(value)).toBe(value.endsWith("\n") ? value.slice(0, -1) : value);
      const singleLine = value.replace(/\n/gu, " ");
      if (singleLine.trim() === "") continue;
      expect(inlineCodeSpan(singleLine), JSON.stringify(value)).toContain(singleLine);
    }
  });
});

describe("Fern page MDX safety", () => {
  it("keeps random text inside nested components balanced and parseable", () => {
    const next = generator(23);
    const names = ["note", "warning", "dropdown", "tab-set", "tip"];
    for (let index = 0; index < CASES / 4; index += 1) {
      let blocks: ConversionBlock[] = [paragraph(text(randomText(next)))];
      const depth = 1 + Math.floor(next() * names.length);
      for (let level = 0; level < depth; level += 1) {
        const name = names[Math.floor(next() * names.length)] as string;
        blocks = [callout(name, [...blocks, paragraph(text(randomText(next)))], randomText(next))];
      }
      const emitted = page(blocks);
      expect(checkFernMdx(emitted), emitted).toEqual([]);
      for (const component of ["Note", "Warning", "Accordion", "Tabs", "Tip"]) {
        const opened = emitted.match(new RegExp(`<${component}[ >]`, "gu"))?.length ?? 0;
        const closed = emitted.match(new RegExp(`</${component}>`, "gu"))?.length ?? 0;
        expect(closed, emitted).toBe(opened);
      }
    }
  });

  it("parses component attributes with @babel/parser", () => {
    const emitted = page([callout("dropdown", [paragraph(text("x"))], 'Say "hi" & {wave} <now>')]);
    const open = emitted.split("\n")[0] as string;
    expect(jsxFragmentParses(`${open}</Accordion>`)).toBe(true);
  });
});

describe("Fern MDX check", () => {
  const issues = (page: string): string[] => checkFernMdx(page).map((issue) => issue.code);

  it("accepts code, math, comments, and built-in components", () => {
    const valid = [
      "---",
      'title: "x {y}"',
      "---",
      "",
      '<Note title={"a \\"b\\""}>',
      "Text with \\{braces\\} and &lt;tags>.",
      "</Note>",
      "",
      "```js",
      "const a = { b: '<c>' };",
      "```",
      "",
      "$$",
      "\\frac{a}{b}",
      "$$",
      "",
      "Inline `{code}` and $x^{2}$ {/* note */}",
      "",
      "<style>{`.a { b: c; }`}</style>",
      "",
    ].join("\n");
    expect(issues(valid)).toEqual([]);
  });

  it("finds bare braces, angle brackets, HTML comments, and custom components", () => {
    expect(issues("a {b} c\n")).toEqual(["bare-brace"]);
    expect(issues("a } c\n")).toEqual(["bare-brace"]);
    expect(issues("a <4 b\n")).toEqual(["bare-angle-bracket"]);
    expect(issues("<!-- x -->\n")).toEqual(["html-comment"]);
    expect(issues("<Callout>\nx\n</Callout>\n")).toEqual(["component-not-built-in"]);
    expect(issues("<Note>\nx\n")).toEqual(["tag-unbalanced"]);
    expect(issues("<Note>\nx\n</Tip>\n")).toEqual(["tag-unbalanced"]);
    expect(issues('<Card title="a" href={b c} />\n')).toEqual(["jsx-parse-failed"]);
    expect(issues("```\ncode\n")).toEqual(["fence-unclosed"]);
    expect(issues("text")).toEqual(["newline-policy"]);
    expect(issues("text\r\n")).toEqual(["newline-policy"]);
  });

  it("detects ESM declarations in flow prose and restricts raw JSX children", () => {
    expect(issues('import Widget from "./widget.js"\n')).toEqual(["esm-block"]);
    expect(issues("export PATH=value\n")).toEqual(["esm-block"]);
    expect(issues("```mdx\nimport Widget from './widget.js'\n```\n")).toEqual([]);
    expect(issues("<Note>{runCode()}</Note>\n")).toContain("bare-brace");
    expect(issues("<style>{runCode()}</style>\n")).toContain("jsx-parse-failed");
    expect(issues("<style>{`a { color: red; }`}</style>\n")).toEqual([]);
  });
});
