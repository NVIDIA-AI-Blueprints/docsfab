// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { canonicalDigest } from "../src/contract-kit/index.js";
import {
  createMystMemoryTree,
  readMystSource,
  resolveConversionIr,
  type ConversionBlock,
  type ConversionDocument,
  type ConversionIrV1,
  type ConversionNode,
  type ConversionSource,
  type SubstitutionEntry,
} from "../src/conversion/index.js";
import { visitNodes } from "../src/conversion/myst/tree.js";

const SOURCE: ConversionSource = {
  generator: "sphinx",
  root: "docs",
  repositoryRevision: "0123456789abcdef0123456789abcdef01234567",
  extensionModules: ["myst_parser"],
};

function readPages(
  files: Record<string, string | Uint8Array>,
  pages: string[] = ["index.md"],
  substitutions?: SubstitutionEntry[],
): ConversionIrV1 {
  return readMystSource({
    source: SOURCE,
    tree: createMystMemoryTree(files),
    pages,
    ...(substitutions ? { substitutions } : {}),
  });
}

function page(text: string): ConversionDocument {
  return readPages({ "index.md": text }).documents[0]!;
}

function nodes<K extends ConversionNode["kind"]>(
  blocks: readonly ConversionNode[],
  kind: K,
): Array<Extract<ConversionNode, { kind: K }>> {
  const found: Array<Extract<ConversionNode, { kind: K }>> = [];
  visitNodes(blocks, (node) => {
    if (node.kind === kind) found.push(node as Extract<ConversionNode, { kind: K }>);
  });
  return found;
}

/** Block kinds with their line spans, for compact structural assertions. */
function outline(blocks: readonly ConversionBlock[]): string[] {
  return blocks.map((block) => `${block.kind}@${block.span.startLine}-${block.span.endLine}`);
}

function refusalOf(action: () => unknown): { code: string; message: string } {
  try {
    action();
  } catch (error) {
    return error as { code: string; message: string };
  }
  throw new Error("expected a refusal");
}

describe("MyST reader block structure", () => {
  it("reads ATX and setext headings with depth and line spans", () => {
    const document = page("# One #\n\nTwo\n===\n\n### Three\n\nFour\nlines\n---\n");
    const headings = nodes(document.children, "heading");
    expect(headings.map((heading) => [heading.depth, heading.span])).toEqual([
      [1, { startLine: 1, endLine: 1 }],
      [1, { startLine: 3, endLine: 4 }],
      [3, { startLine: 6, endLine: 6 }],
      [2, { startLine: 8, endLine: 10 }],
    ]);
    expect(headings[0]!.children).toMatchObject([{ kind: "text", value: "One" }]);
    expect(headings[3]!.children).toMatchObject([{ kind: "text", value: "Four\nlines" }]);
  });

  it("reads paragraphs with soft and hard line breaks", () => {
    const document = page("First line\nsoft  \nhard\\\nlast\n\nSecond paragraph.\n");
    expect(outline(document.children)).toEqual(["paragraph@1-4", "paragraph@6-6"]);
    const first = document.children[0]!;
    expect(first.kind === "paragraph" && first.children.map((node) => node.kind)).toEqual([
      "text",
      "lineBreak",
      "text",
      "lineBreak",
      "text",
    ]);
    expect(nodes([first], "lineBreak").map((node) => node.span.startLine)).toEqual([2, 3]);
    expect(nodes([first], "text").map((node) => node.value)).toEqual([
      "First line\nsoft",
      "hard",
      "last",
    ]);
  });

  it("reads ordered, unordered, and nested lists with item spans", () => {
    const document = page(
      "- one\n- two\n  continued\n\n  - nested a\n  - nested b\n- three\n\n3. third\n4. fourth\n",
    );
    expect(outline(document.children)).toEqual(["list@1-7", "list@9-10"]);
    const [bullets, ordered] = document.children;
    expect(bullets).toMatchObject({ kind: "list", ordered: false });
    expect(ordered).toMatchObject({ kind: "list", ordered: true, start: 3 });
    const items = bullets!.kind === "list" ? bullets.items : [];
    expect(items.map((item) => item.span)).toEqual([
      { startLine: 1, endLine: 1 },
      { startLine: 2, endLine: 6 },
      { startLine: 7, endLine: 7 },
    ]);
    expect(outline(items[1]!.children)).toEqual(["paragraph@2-3", "list@5-6"]);
  });

  it("reads a GFM pipe table with alignments and cell spans", () => {
    const document = page("| Name | Size |\n|:-----|-----:|\n| a \\| b | `1` |\n| c | |\n");
    const table = document.children[0]!;
    expect(table).toMatchObject({
      kind: "table",
      alignments: ["left", "right"],
      span: { startLine: 1, endLine: 4 },
    });
    if (table.kind !== "table") throw new Error("expected a table");
    expect(table.headerRows).toHaveLength(1);
    expect(table.bodyRows).toHaveLength(2);
    expect(nodes(table.bodyRows[0]!.cells[0]!.children, "text")[0]).toMatchObject({
      value: "a | b",
      span: { startLine: 3, endLine: 3 },
    });
    expect(nodes(table.bodyRows[0]!.cells[1]!.children, "inlineCode")[0]?.value).toBe("1");
    expect(table.bodyRows[1]!.cells[1]!.children).toEqual([]);
  });

  it("reads fenced and indented code blocks with language, meta, and spans", () => {
    const document = page(
      '```python title="x.py"\nprint(1)\n\nprint(2)\n```\n\n~~~\n```\n~~~\n\n    indented\n      more\n',
    );
    expect(document.children).toMatchObject([
      {
        kind: "codeBlock",
        language: "python",
        meta: 'title="x.py"',
        value: "print(1)\n\nprint(2)",
        span: { startLine: 1, endLine: 5 },
      },
      { kind: "codeBlock", value: "```", span: { startLine: 7, endLine: 9 } },
      { kind: "codeBlock", value: "indented\n  more", span: { startLine: 11, endLine: 12 } },
    ]);
  });

  it("reads blockquotes with nesting and lazy continuation", () => {
    const document = page("> quoted\nlazy line\n>\n> > inner\n\nafter\n");
    expect(outline(document.children)).toEqual(["blockquote@1-4", "paragraph@6-6"]);
    const quote = document.children[0]!;
    if (quote.kind !== "blockquote") throw new Error("expected a block quote");
    expect(outline(quote.children)).toEqual(["paragraph@1-2", "blockquote@4-4"]);
  });

  it("reads thematic breaks, HTML blocks, and percent and HTML comments", () => {
    const document = page(
      '***\n\n<div class="x">\n**raw**\n</div>\n\n% first\n% second\n\n<!-- note -->\n\n<Note>\nBody\n</Note>\n',
    );
    expect(document.children).toMatchObject([
      { kind: "thematicBreak", span: { startLine: 1, endLine: 1 } },
      {
        kind: "html",
        value: '<div class="x">\n**raw**\n</div>',
        span: { startLine: 3, endLine: 5 },
      },
      { kind: "comment", value: "first\nsecond", span: { startLine: 7, endLine: 8 } },
      { kind: "comment", value: "note", span: { startLine: 10, endLine: 10 } },
      { kind: "html", value: "<Note>\nBody\n</Note>", span: { startLine: 12, endLine: 14 } },
    ]);
  });

  it("reads (label)= targets into the label table with the next heading as title", () => {
    const ir = readPages({
      "index.md": "(page-label)=\n# Page *Title*\n\n(section-label)=\n## Section\n",
    });
    const document = ir.documents[0]!;
    expect(nodes(document.children, "target")).toMatchObject([
      { label: "page-label", span: { startLine: 1, endLine: 1 } },
      { label: "section-label", span: { startLine: 4, endLine: 4 } },
    ]);
    expect(ir.labels).toEqual([
      {
        label: "page-label",
        documentId: document.id,
        title: "Page Title",
        span: { startLine: 1, endLine: 1 },
      },
      {
        label: "section-label",
        documentId: document.id,
        anchor: "section-label",
        title: "Section",
        span: { startLine: 4, endLine: 4 },
      },
    ]);
  });

  it("reads frontmatter and frontmatter substitutions", () => {
    const ir = readPages({
      "index.md":
        "---\ntitle: Guide\nsubstitutions:\n  product: NeMo\n  matrix: [1, 2]\n---\n\n# {{ product }}\n",
    });
    const document = ir.documents[0]!;
    expect(document.frontmatter).toEqual({
      title: "Guide",
      substitutions: { product: "NeMo", matrix: [1, 2] },
    });
    expect(outline(document.children)).toEqual(["heading@8-8"]);
    expect(ir.substitutions).toEqual([
      {
        name: "product",
        value: { kind: "literal", text: "NeMo" },
        origin: {
          kind: "document",
          documentId: document.id,
          sourcePath: "docs/index.md",
          span: { startLine: 1, endLine: 6 },
        },
      },
      {
        name: "matrix",
        value: { kind: "computed", expression: "[1,2]" },
        origin: {
          kind: "document",
          documentId: document.id,
          sourcePath: "docs/index.md",
          span: { startLine: 1, endLine: 6 },
        },
      },
    ]);
    expect(resolveConversionIr(ir).units.map((unit) => unit.id)).toEqual([
      "unit:substitution:matrix",
    ]);
  });
});

describe("MyST reader directives", () => {
  it("reads backtick and colon directive fences nested to depth with recursive bodies", () => {
    const document = page(
      [
        "::::{tab-set}",
        ":::{tab-item} First",
        "````{note}",
        "```{warning}",
        "Deep *text*.",
        "```",
        "````",
        ":::",
        ":::{tab-item} Second",
        "Two.",
        ":::",
        "::::",
        "",
      ].join("\n"),
    );
    const directives = nodes(document.children, "directive");
    expect(directives.map((node) => [node.name, node.argument, node.span])).toEqual([
      ["tab-set", undefined, { startLine: 1, endLine: 12 }],
      ["tab-item", "First", { startLine: 2, endLine: 8 }],
      ["note", undefined, { startLine: 3, endLine: 7 }],
      ["warning", undefined, { startLine: 4, endLine: 6 }],
      ["tab-item", "Second", { startLine: 9, endLine: 11 }],
    ]);
    const warning = directives[3]!;
    expect(warning.body.kind).toBe("blocks");
    expect(nodes([warning], "emphasis")).toMatchObject([
      { span: { startLine: 5, endLine: 5 }, children: [{ kind: "text", value: "text" }] },
    ]);
  });

  it("closes a fence only at a marker at least as long, so equal-length fences do not nest", () => {
    const document = page(":::{note}\nOne\n:::{tip}\nTwo\n:::\nafter\n");
    expect(outline(document.children)).toEqual(["directive@1-5", "paragraph@6-6"]);
    const note = document.children[0]!;
    if (note.kind !== "directive" || note.body.kind !== "blocks")
      throw new Error("expected a body");
    expect(outline(note.body.children)).toEqual(["paragraph@2-2", "directive@3-4"]);
  });

  it("reads :key: value and YAML option blocks", () => {
    const document = page(
      [
        "```{admonition} Title",
        ":class: tip",
        ":open:",
        "",
        "Body.",
        "```",
        "",
        ":::{dropdown} More",
        "---",
        "open: true",
        "color: primary",
        "---",
        "Hidden body.",
        ":::",
        "",
      ].join("\n"),
    );
    const [admonition, dropdown] = nodes(document.children, "directive");
    expect(admonition).toMatchObject({
      name: "admonition",
      argument: "Title",
      options: [{ name: "class", value: "tip" }, { name: "open" }],
    });
    expect(nodes([admonition!], "paragraph")[0]?.span).toEqual({ startLine: 5, endLine: 5 });
    expect(dropdown).toMatchObject({
      name: "dropdown",
      options: [
        { name: "open", value: "true" },
        { name: "color", value: "primary" },
      ],
    });
    expect(nodes([dropdown!], "paragraph")[0]?.span).toEqual({ startLine: 13, endLine: 13 });
  });

  it("keeps literal-bodied directives as text and lower-cases directive names", () => {
    const document = page(
      '```{CSV-Table} Sizes\n:header-rows: 1\n\n"a, b",c\n```\n\n```{mermaid}\ngraph TD; A-->B\n```\n',
    );
    expect(document.children).toMatchObject([
      {
        kind: "directive",
        name: "csv-table",
        argument: "Sizes",
        options: [{ name: "header-rows", value: "1" }],
        body: { kind: "text", value: '"a, b",c' },
      },
      { kind: "directive", name: "mermaid", body: { kind: "text", value: "graph TD; A-->B" } },
    ]);
  });

  it("normalizes code-block, image, figure, math, and raw html directives into typed nodes", () => {
    const ir = readPages(
      {
        "guide/index.md": [
          "```{code-block} python",
          ":caption: example.py",
          ":emphasize-lines: 1,3-4",
          ":linenos:",
          ":lineno-start: 10",
          ":name: example-code",
          ":dedent: 2",
          "",
          "print(1)",
          "```",
          "",
          "```{image} ../_static/logo.png",
          ":alt: Logo",
          ":width: 80%",
          ":class: dark",
          "```",
          "",
          ":::{figure} /_static/arch.svg",
          ":name: arch",
          ":align: center",
          "",
          "The *architecture*.",
          "",
          "Legend.",
          ":::",
          "",
          "```{math}",
          ":label: euler",
          "e^{i\\pi} + 1 = 0",
          "```",
          "",
          "```{raw} html",
          "<b>raw</b>",
          "```",
          "",
        ].join("\n"),
      },
      ["guide/index.md"],
    );
    const document = ir.documents[0]!;
    expect(document.children).toMatchObject([
      {
        kind: "codeBlock",
        language: "python",
        value: "print(1)",
        options: {
          caption: "example.py",
          emphasizeLines: [
            { start: 1, end: 1 },
            { start: 3, end: 4 },
          ],
          lineNumbers: true,
          firstLineNumber: 10,
          name: "example-code",
          other: [{ name: "dedent", value: "2" }],
        },
        span: { startLine: 1, endLine: 10 },
      },
      {
        kind: "image",
        source: "../_static/logo.png",
        assetId: "asset:image:docs/_static/logo.png",
        options: { alt: "Logo", width: "80%", other: [{ name: "class", value: "dark" }] },
        span: { startLine: 12, endLine: 16 },
      },
      {
        kind: "figure",
        label: "arch",
        image: { source: "/_static/arch.svg", options: { align: "center" } },
        caption: [
          { kind: "text", value: "The " },
          { kind: "emphasis" },
          { kind: "text", value: "." },
        ],
        legend: [{ kind: "paragraph", span: { startLine: 24, endLine: 24 } }],
        span: { startLine: 18, endLine: 25 },
      },
      {
        kind: "math",
        value: "e^{i\\pi} + 1 = 0",
        label: "euler",
        span: { startLine: 27, endLine: 30 },
      },
      { kind: "html", value: "<b>raw</b>", span: { startLine: 32, endLine: 34 } },
    ]);
    expect(ir.assets).toEqual([
      {
        id: "asset:image:docs/_static/arch.svg",
        sourcePath: "docs/_static/arch.svg",
        role: "image",
      },
      {
        id: "asset:image:docs/_static/logo.png",
        sourcePath: "docs/_static/logo.png",
        role: "image",
      },
    ]);
    expect(ir.labels.map((entry) => [entry.label, entry.title])).toEqual([
      ["example-code", "example.py"],
      ["arch", "The architecture."],
    ]);
  });

  it("captures toctree entries, caption, hidden, glob, titled entries, and self", () => {
    const document = page(
      [
        "```{toctree}",
        ":caption: Guides",
        ":hidden:",
        ":glob:",
        ":maxdepth: 2",
        "",
        "Home <self>",
        "install",
        "Advanced topics <advanced/index>",
        "tutorials/*",
        "GitHub <https://github.com/example>",
        "```",
        "",
      ].join("\n"),
    );
    expect(document.children).toMatchObject([
      {
        kind: "directive",
        name: "toctree",
        options: [
          { name: "caption", value: "Guides" },
          { name: "hidden" },
          { name: "glob" },
          { name: "maxdepth", value: "2" },
        ],
        body: {
          kind: "toctree",
          caption: "Guides",
          hidden: true,
          glob: true,
          entries: [
            { kind: "self", title: "Home", span: { startLine: 7, endLine: 7 } },
            { kind: "document", target: "install", span: { startLine: 8, endLine: 8 } },
            {
              kind: "document",
              target: "advanced/index",
              title: "Advanced topics",
              span: { startLine: 9, endLine: 9 },
            },
            { kind: "glob", pattern: "tutorials/*", span: { startLine: 10, endLine: 10 } },
            {
              kind: "url",
              url: "https://github.com/example",
              title: "GitHub",
              span: { startLine: 11, endLine: 11 },
            },
          ],
        },
        span: { startLine: 1, endLine: 12 },
      },
    ]);
  });
});

describe("MyST reader inline structure", () => {
  it("reads emphasis, strong, code spans, links, images, autolinks, and inline HTML with spans", () => {
    const document = page(
      [
        "Some *em* and __strong__ with ``a ` tick`` and",
        '[a link](https://example.com/x "Title") plus ![alt **text**](img/a.png)',
        "and <https://auto.example> and <kbd>K</kbd>.",
        "",
      ].join("\n"),
    );
    const paragraph = document.children[0]!;
    expect(paragraph.span).toEqual({ startLine: 1, endLine: 3 });
    expect(nodes([paragraph], "emphasis")[0]).toMatchObject({
      children: [{ kind: "text", value: "em" }],
      span: { startLine: 1, endLine: 1 },
    });
    expect(nodes([paragraph], "strong")[0]?.children).toMatchObject([{ value: "strong" }]);
    expect(nodes([paragraph], "inlineCode")[0]).toMatchObject({ value: "a ` tick" });
    expect(nodes([paragraph], "link")).toMatchObject([
      {
        url: "https://example.com/x",
        title: "Title",
        children: [{ kind: "text", value: "a link" }],
        span: { startLine: 2, endLine: 2 },
      },
      { url: "https://auto.example", span: { startLine: 3, endLine: 3 } },
    ]);
    expect(nodes([paragraph], "inlineImage")).toMatchObject([
      {
        source: "img/a.png",
        alt: "alt text",
        assetId: "asset:image:docs/img/a.png",
        span: { startLine: 2, endLine: 2 },
      },
    ]);
    expect(nodes([paragraph], "inlineHtml").map((node) => node.value)).toEqual(["<kbd>", "</kbd>"]);
  });

  it.each([
    ["inline", '![diagram](diagram.png "Deployment architecture")\n'],
    ["reference", '![diagram][arch]\n\n[arch]: diagram.png "Deployment architecture"\n'],
  ])("refuses an image title the IR cannot preserve (%s form)", (_kind, source) => {
    const refusal = refusalOf(() => readPages({ "index.md": source }));

    expect(refusal).toMatchObject({
      code: "conversion-image-title-unsupported",
      construct: "image:inline-title",
    });
    expect(refusal.message).toContain("docs/index.md:1");
    expect((refusal as unknown as { nextAction: string }).nextAction).toContain(
      "visible alt text or a caption",
    );
  });

  it("reads roles with display and target and lower-cases role names", () => {
    const document = page(
      "See {ref}`Install guide <install>`, {Doc}`/guide/index`, and\n{external+gpu-op:ref}`cache-options`.\n",
    );
    expect(nodes(document.children, "role")).toEqual([
      {
        kind: "role",
        id: expect.any(String),
        name: "ref",
        content: "Install guide <install>",
        display: "Install guide",
        target: "install",
        span: { startLine: 1, endLine: 1 },
      },
      {
        kind: "role",
        id: expect.any(String),
        name: "doc",
        content: "/guide/index",
        target: "/guide/index",
        span: { startLine: 1, endLine: 1 },
      },
      {
        kind: "role",
        id: expect.any(String),
        name: "external+gpu-op:ref",
        content: "cache-options",
        target: "cache-options",
        span: { startLine: 2, endLine: 2 },
      },
    ]);
  });

  it("reads substitution references and footnotes", () => {
    const document = page(
      "Use {{ product }} here.[^note]\n\n[^note]: The *note*\n    continues.\n",
    );
    expect(nodes(document.children, "substitutionReference")).toMatchObject([
      { name: "product", span: { startLine: 1, endLine: 1 } },
    ]);
    expect(nodes(document.children, "footnoteReference")).toMatchObject([{ label: "note" }]);
    expect(document.children[1]).toMatchObject({
      kind: "footnoteDefinition",
      label: "note",
      span: { startLine: 3, endLine: 4 },
    });
  });

  it("resolves reference links from definitions anywhere in the page", () => {
    const document = page(
      'Read [the docs][docs] and [Docs].\n\n> [docs]: https://docs.example "D"\n',
    );
    expect(nodes(document.children, "link")).toMatchObject([
      { url: "https://docs.example", title: "D", children: [{ value: "the docs" }] },
      { url: "https://docs.example", children: [{ value: "Docs" }] },
    ]);
  });

  it("keeps unmatched delimiters and brackets as literal text", () => {
    const document = page("2 * 3 and [not a link] and `open\n");
    expect(nodes(document.children, "text").map((node) => node.value)).toEqual([
      "2 * 3 and [not a link] and `open",
    ]);
  });
});

describe("MyST reader includes and refusals", () => {
  it("records includes: markup includes become documents and remote includes are never read", () => {
    const ir = readPages({
      "index.md":
        "```{include} snippets/part.md\n:start-after: <!-- start -->\n```\n\n```{literalinclude} ../docs/code/sample.py\n:language: python\n:lines: 2-3\n:pyobject: greet\n```\n\n```{literalinclude} https://example.com/remote.py\n```\n\n```{rli} https://example.com/sample.yaml\n```\n",
      "snippets/part.md": "Shared **text**.\n\n```{include} ../shared/deeper.md\n```\n",
      "shared/deeper.md": "Deeper.\n",
      "code/sample.py": "def greet():\n    return 1\n",
    });
    expect(ir.documents.map((document) => document.sourcePath)).toEqual([
      "docs/index.md",
      "docs/snippets/part.md",
      "docs/shared/deeper.md",
    ]);
    expect(nodes(ir.documents[0]!.children, "include")).toMatchObject([
      {
        mode: "markup",
        target: { kind: "local", path: "docs/snippets/part.md" },
        startAfter: "<!-- start -->",
        span: { startLine: 1, endLine: 3 },
      },
      {
        mode: "literal",
        target: { kind: "local", path: "docs/code/sample.py" },
        language: "python",
        lines: [{ start: 2, end: 3 }],
        pyobject: "greet",
      },
      { mode: "literal", target: { kind: "remote", url: "https://example.com/remote.py" } },
      { mode: "literal", target: { kind: "remote", url: "https://example.com/sample.yaml" } },
    ]);
    expect(ir.assets.map((asset) => asset.id)).toEqual([
      "asset:include-source:docs/code/sample.py",
      "asset:include-source:docs/shared/deeper.md",
      "asset:include-source:docs/snippets/part.md",
    ]);
    const units = resolveConversionIr(ir).units;
    expect(units.map((unit) => (unit.kind === "remote-include" ? unit.url : unit.kind))).toEqual([
      "https://example.com/remote.py",
      "https://example.com/sample.yaml",
    ]);
  });

  it("refuses an include that escapes the documentation root", () => {
    for (const argument of ["../outside.md", "/../outside.md", "../../etc/passwd"]) {
      const refusal = refusalOf(() =>
        readPages({ "index.md": `\`\`\`{include} ${argument}\n\`\`\`\n` }),
      );
      expect(refusal.code, argument).toBe("conversion-include-outside-root");
      expect(refusal.message, argument).toContain("docs/index.md:1");
    }
    const literal = refusalOf(() =>
      readPages({ "sub/page.md": "```{literalinclude} ../../secret.py\n```\n" }, ["sub/page.md"]),
    );
    expect(literal.code).toBe("conversion-include-outside-root");
  });

  it("refuses a missing include and a markup include cycle", () => {
    expect(refusalOf(() => readPages({ "index.md": "```{include} gone.md\n```\n" })).code).toBe(
      "conversion-include-missing",
    );
    expect(
      refusalOf(() => readPages({ "index.md": "```{literalinclude} gone.py\n```\n" })).code,
    ).toBe("conversion-include-missing");
    const cycle = refusalOf(() =>
      readPages({
        "index.md": "```{include} a.md\n```\n",
        "a.md": "```{include} b.md\n```\n",
        "b.md": "```{include} a.md\n```\n",
      }),
    );
    expect(cycle.code).toBe("conversion-include-cycle");
    expect(cycle.message).toContain("docs/a.md -> docs/b.md -> docs/a.md");
  });

  it("refuses unreadable input with named codes", () => {
    expect(refusalOf(() => page("---\n- not\n- a mapping\n---\n")).code).toBe(
      "conversion-frontmatter-invalid",
    );
    expect(refusalOf(() => page("---\ntitle: [unclosed\n---\n")).code).toBe(
      "conversion-frontmatter-invalid",
    );
    expect(refusalOf(() => page(":::{note}\n---\n- a\n---\nBody\n:::\n")).code).toBe(
      "conversion-directive-options-invalid",
    );
    expect(
      refusalOf(() => readPages({ "index.md": new Uint8Array([0x23, 0x20, 0xff, 0xfe]) })).code,
    ).toBe("conversion-source-encoding");
    expect(refusalOf(() => readPages({}, ["missing.md"])).code).toBe("conversion-source-missing");
    expect(refusalOf(() => page("![x](../../../outside.png)\n")).code).toBe(
      "conversion-asset-outside-repository",
    );
  });

  it("refuses a substitution defined twice with different values", () => {
    const configured: SubstitutionEntry = {
      name: "product",
      value: { kind: "literal", text: "NeMo" },
      origin: { kind: "configuration", path: "docs/conf.py", span: { startLine: 3, endLine: 3 } },
    };
    const same = readPages(
      { "index.md": "---\nsubstitutions:\n  product: NeMo\n---\n" },
      ["index.md"],
      [configured],
    );
    expect(same.substitutions).toEqual([configured]);
    const conflict = refusalOf(() =>
      readPages(
        { "index.md": "---\nsubstitutions:\n  product: Other\n---\n" },
        ["index.md"],
        [configured],
      ),
    );
    expect(conflict.code).toBe("conversion-substitution-conflict");
  });
});

describe("MyST reader IR contract", () => {
  const KITCHEN_SINK = [
    "---",
    "title: Kitchen sink",
    "---",
    "(top)=",
    "# Title",
    "",
    "Text with {term}`Glossary` and {custom-role}`x`.",
    "",
    "::::{grid} 2",
    ":::{grid-item-card} Card",
    "Body",
    ":::",
    "::::",
    "",
    "```{only} html",
    "Conditional.",
    "```",
    "",
    "```{automodule} pkg.mod",
    "```",
    "",
    "```{my-custom} arg",
    ":opt: 1",
    "",
    "Custom body.",
    "```",
    "",
  ].join("\n");

  it("gives every node a unique id and a span, and the resolver accepts the IR", () => {
    const ir = readPages({ "index.md": KITCHEN_SINK });
    const ids = new Set<string>();
    visitNodes(ir.documents[0]!.children, (node) => {
      expect(ids.has(node.id), node.id).toBe(false);
      ids.add(node.id);
      expect(node.span.startLine).toBeGreaterThanOrEqual(1);
      expect(node.span.endLine).toBeGreaterThanOrEqual(node.span.startLine);
    });
    const resolution = resolveConversionIr(ir);
    expect(resolution.nodes).toHaveLength(ids.size);
    expect(resolution.units.map((unit) => unit.kind)).toEqual([
      "custom-construct",
      "conditional-content",
      "custom-construct",
    ]);
    expect(resolution.refusals.map((refusal) => refusal.construct)).toEqual([
      "directive:automodule",
    ]);
  });

  it("produces the same IR digest for the same bytes regardless of page order", () => {
    const files = { "index.md": KITCHEN_SINK, "other.md": "# Other\n\n{ref}`top`\n" };
    const first = canonicalDigest(readPages(files, ["index.md", "other.md"]));
    const second = canonicalDigest(readPages({ ...files }, ["other.md", "index.md"]));
    expect(second).toBe(first);
    const changed = canonicalDigest(
      readPages({ ...files, "other.md": "# Other\n\n{ref}`top`.\n" }, ["index.md", "other.md"]),
    );
    expect(changed).not.toBe(first);
  });
});
