// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  CONSTRUCT_RULE_REGISTRY,
  buildConstructRuleIndex,
  resolveConversionIr,
  type AmbiguityAnswer,
  type ConversionBlock,
  type ConversionDocument,
  type ConversionInline,
  type ConversionIrV1,
  type ConversionRuleOverride,
  type ConvertTargetName,
  type DirectiveBody,
  type LabelEntry,
  type ListItemNode,
  type SourceOption,
  type SubstitutionEntry,
} from "../src/conversion/index.js";
import {
  FERN_EMITTED_INTENTS,
  FERN_INTENT_EMITTERS,
  checkFernMdx,
  emitFernPage,
  type FernEmitSources,
  type FernPageFrontmatter,
  type FernPageResult,
} from "../src/conversion/fern/index.js";
import * as fernMdxCheck from "../src/conversion/fern/mdx-check.js";

const span = { startLine: 1, endLine: 1 };
let counter = 0;
const nextId = (prefix: string): string => {
  counter += 1;
  return `${prefix}-${counter}`;
};

const t = (value: string): ConversionInline => ({ id: nextId("text"), kind: "text", value, span });
const em = (...children: ConversionInline[]): ConversionInline => ({
  id: nextId("em"),
  kind: "emphasis",
  children,
  span,
});
const strong = (...children: ConversionInline[]): ConversionInline => ({
  id: nextId("strong"),
  kind: "strong",
  children,
  span,
});
const code = (value: string): ConversionInline => ({
  id: nextId("code"),
  kind: "inlineCode",
  value,
  span,
});
const link = (url: string, ...children: ConversionInline[]): ConversionInline => ({
  id: nextId("link"),
  kind: "link",
  url,
  children,
  span,
});
const inlineHtml = (value: string): ConversionInline => ({
  id: nextId("ihtml"),
  kind: "inlineHtml",
  value,
  span,
});
const role = (
  name: string,
  content: string,
  extra: { display?: string; target?: string } = {},
): ConversionInline => ({ id: nextId("role"), kind: "role", name, content, ...extra, span });
const p = (...children: ConversionInline[]): ConversionBlock => ({
  id: nextId("p"),
  kind: "paragraph",
  children,
  span,
});
const h = (depth: number, ...children: ConversionInline[]): ConversionBlock => ({
  id: nextId("h"),
  kind: "heading",
  depth,
  children,
  span,
});
const item = (...children: ConversionBlock[]): ListItemNode => ({
  id: nextId("li"),
  kind: "listItem",
  children,
  span,
});
const list = (ordered: boolean, items: ListItemNode[], start?: number): ConversionBlock => ({
  id: nextId("list"),
  kind: "list",
  ordered,
  items,
  ...(start === undefined ? {} : { start }),
  span,
});
const codeBlock = (
  value: string,
  language?: string,
  options: Partial<Extract<ConversionBlock, { kind: "codeBlock" }>["options"]> = {},
): ConversionBlock => ({
  id: nextId("code"),
  kind: "codeBlock",
  value,
  ...(language === undefined ? {} : { language }),
  options: { other: [], ...options },
  span,
});
const directive = (
  name: string,
  body: DirectiveBody | ConversionBlock[] = { kind: "none" },
  argument?: string,
  options: SourceOption[] = [],
): ConversionBlock => ({
  id: nextId(`d-${name}`),
  kind: "directive",
  name,
  ...(argument === undefined ? {} : { argument }),
  options,
  body: Array.isArray(body) ? { kind: "blocks", children: body } : body,
  span,
});
const textBody = (value: string): DirectiveBody => ({ kind: "text", value });
const image = (
  source: string,
  options: Partial<Extract<ConversionBlock, { kind: "image" }>["options"]> = {},
) =>
  ({
    id: nextId("img"),
    kind: "image",
    source,
    options: { other: [], ...options },
    span,
  }) as Extract<ConversionBlock, { kind: "image" }>;

function document(children: ConversionBlock[], id = "page"): ConversionDocument {
  return { id, sourcePath: `docs/${id}.md`, format: "myst", frontmatter: {}, children };
}

interface PageSetup {
  frontmatter?: FernPageFrontmatter;
  overrides?: ConversionRuleOverride[];
  answers?: Array<[string, AmbiguityAnswer]>;
  labels?: LabelEntry[];
  substitutions?: SubstitutionEntry[];
  documents?: ConversionDocument[];
  sources?: FernEmitSources;
}

function irOf(children: ConversionBlock[], setup: PageSetup = {}): ConversionIrV1 {
  return {
    schemaVersion: 1,
    source: { generator: "sphinx", root: "docs", repositoryRevision: "0", extensionModules: [] },
    documents: [document(children), ...(setup.documents ?? [])],
    navigation: { entries: [] },
    labels: setup.labels ?? [],
    routes: [],
    assets: [],
    substitutions: setup.substitutions ?? [],
    dropLedger: [],
  };
}

function emit(children: ConversionBlock[], setup: PageSetup = {}): FernPageResult {
  const ir = irOf(children, setup);
  // The IR must be one a reader could hand over: resolution accepts it.
  resolveConversionIr(ir, { overrides: setup.overrides ?? [] });
  return emitFernPage({
    ir,
    documentId: "page",
    rules: buildConstructRuleIndex(CONSTRUCT_RULE_REGISTRY, setup.overrides ?? []),
    ...(setup.answers === undefined ? {} : { answers: new Map(setup.answers) }),
    ...(setup.frontmatter === undefined ? {} : { frontmatter: setup.frontmatter }),
    ...(setup.sources === undefined ? {} : { sources: setup.sources }),
  });
}

function pageText(children: ConversionBlock[], setup: PageSetup = {}): string {
  const result = emit(children, setup);
  if (result.status !== "emitted") {
    throw new Error(`Expected an emitted page, got ${JSON.stringify(result.refusals)}`);
  }
  expect(checkFernMdx(result.text)).toEqual([]);
  return result.text;
}

const files = (entries: Record<string, string>): FernEmitSources => ({
  readText: (request) => entries[request.path],
});

interface GoldenCase {
  intent: ConvertTargetName;
  name: string;
  children: () => ConversionBlock[];
  setup?: PageSetup;
  expected: string;
}

const GOLDEN: GoldenCase[] = [
  {
    intent: "markdown",
    name: "headings, paragraphs, inline formatting, and links",
    children: () => [
      h(2, t("Install "), code("pip")),
      p(
        t("Run "),
        strong(t("this")),
        t(" and "),
        em(t("that")),
        t(", then read "),
        link("https://example.com/a b", t("the guide")),
        t("."),
      ),
    ],
    expected:
      "## Install `pip`\n\nRun **this** and *that*, then read [the guide](https://example.com/a%20b).\n",
  },
  {
    intent: "markdown",
    name: "tight and loose lists, blockquotes, and breaks",
    children: () => [
      list(
        true,
        [item(p(t("First"))), item(p(t("Second")), list(false, [item(p(t("nested")))]))],
        3,
      ),
      list(false, [item(p(t("One")), p(t("more"))), item(p(t("Two")))]),
      { id: nextId("bq"), kind: "blockquote", children: [p(t("Quoted")), p(t("text"))], span },
      { id: nextId("hr"), kind: "thematicBreak", span },
    ],
    expected:
      "3. First\n4. Second\n   - nested\n\n- One\n\n  more\n\n- Two\n\n> Quoted\n>\n> text\n\n***\n",
  },
  {
    intent: "markdown",
    name: "definition lists, line blocks, and footnotes",
    children: () => [
      {
        id: nextId("dl"),
        kind: "definitionList",
        items: [{ term: [t("GPU")], definition: [p(t("A processor."))] }],
        span,
      },
      { id: nextId("lb"), kind: "lineBlock", lines: [[t("one")], [t("two")]], span },
      p(t("Claim"), { id: nextId("fnref"), kind: "footnoteReference", label: "1", span }),
      {
        id: nextId("fn"),
        kind: "footnoteDefinition",
        label: "1",
        children: [p(t("Source."))],
        span,
      },
    ],
    expected:
      "<dl>\n<dt>GPU</dt>\n<dd>A processor.</dd>\n</dl>\n\none<br />\ntwo\n\nClaim[^1]\n\n[^1]: Source.\n",
  },
  {
    intent: "code-block",
    name: "caption and emphasized lines become fence attributes",
    children: () => [
      codeBlock("import os\nprint(os.sep)", "python", {
        caption: "example.py",
        emphasizeLines: [
          { start: 2, end: 2 },
          { start: 4, end: 5 },
        ],
      }),
    ],
    expected: '```python title="example.py" {2,4-5}\nimport os\nprint(os.sep)\n```\n',
  },
  {
    intent: "code-block",
    name: "doctest bodies are Python fences",
    children: () => [directive("doctest", textBody(">>> 1 + 1\n2"))],
    expected: "```python\n>>> 1 + 1\n2\n```\n",
  },
  {
    intent: "code-include",
    name: "literal includes inline the selected lines",
    children: () => [
      {
        id: nextId("inc"),
        kind: "include",
        mode: "literal",
        target: { kind: "local", path: "sample.py" },
        language: "python",
        caption: "greet",
        pyobject: "greet",
        other: [],
        span,
      },
    ],
    setup: {
      sources: files({
        "sample.py":
          'import os\n\n\n@cache\ndef greet(name):\n    return f"Hello, {name}"\n\n\ndef unused():\n    return os.sep\n',
      }),
    },
    expected:
      '```python title="greet"\n@cache\ndef greet(name):\n    return f"Hello, {name}"\n```\n',
  },
  {
    intent: "markup-include",
    name: "markup includes inline the included document",
    children: () => [
      p(t("Before.")),
      {
        id: nextId("inc"),
        kind: "include",
        mode: "markup",
        target: { kind: "local", path: "snippet.md" },
        other: [],
        span,
      },
    ],
    setup: {
      documents: [document([p(t("Included text."))], "snippet")],
      sources: { document: () => document([p(t("Included text."))], "snippet") },
    },
    expected: "Before.\n\nIncluded text.\n",
  },
  {
    intent: "table",
    name: "single-line cells become a pipe table",
    children: () => [
      {
        id: nextId("table"),
        kind: "table",
        headerRows: [{ cells: [{ children: [p(t("Name"))] }, { children: [p(t("Value"))] }] }],
        bodyRows: [{ cells: [{ children: [p(t("a|b"))] }, { children: [p(code("x"))] }] }],
        span,
      },
    ],
    expected: "| Name | Value |\n| --- | --- |\n| a\\|b | `x` |\n",
  },
  {
    intent: "table",
    name: "list-table with multi-block cells becomes an HTML table",
    children: () => [
      directive(
        "list-table",
        [
          list(false, [
            item(list(false, [item(p(t("Setting"))), item(p(t("Example")))])),
            item(
              list(false, [
                item(p(t("Password"))),
                item(p(t("Multi-line description")), codeBlock("password: <evalpass>", "yaml")),
              ]),
            ),
          ]),
        ],
        "Settings",
        [{ name: "header-rows", value: "1" }],
      ),
    ],
    expected:
      "<table>\n<caption>Settings</caption>\n<thead>\n<tr>\n<th>Setting</th>\n<th>Example</th>\n</tr>\n</thead>\n<tbody>\n<tr>\n<td>Password</td>\n<td>\n\nMulti-line description\n\n```yaml\npassword: <evalpass>\n```\n\n</td>\n</tr>\n</tbody>\n</table>\n",
  },
  {
    intent: "table",
    name: "csv-table honors quoting and pads short rows",
    children: () => [
      directive("csv-table", textBody('"Smith, J", "Says ""hi"""\nLee'), undefined, [
        { name: "header", value: '"Name", "Notes"' },
      ]),
    ],
    expected: '| Name | Notes |\n| --- | --- |\n| Smith, J | Says "hi" |\n| Lee |  |\n',
  },
  {
    intent: "callout",
    name: "admonitions become built-in callouts",
    children: () => [
      directive("warning", [p(t("Back up first."))]),
      directive("tip", [p(t("Use a cache."))]),
    ],
    expected: "<Warning>\nBack up first.\n</Warning>\n<Tip>\nUse a cache.\n</Tip>\n",
  },
  {
    intent: "collapsible",
    name: "dropdowns become accordions",
    children: () => [directive("dropdown", [p(t("Details here."))], 'Show "more"')],
    expected: '<Accordion title={"Show \\"more\\""}>\nDetails here.\n</Accordion>\n',
  },
  {
    intent: "tabs",
    name: "tab sets become tabs",
    children: () => [
      directive("tab-set", [
        directive("tab-item", [p(t("One."))], "First"),
        directive("tab-item", [p(t("Two."))], "Second"),
      ]),
    ],
    expected:
      '<Tabs>\n<Tab title="First">\nOne.\n</Tab>\n<Tab title="Second">\nTwo.\n</Tab>\n</Tabs>\n',
  },
  {
    intent: "tab",
    name: "a tab item keeps its title",
    children: () => [directive("tab-item", [p(t("Linux steps."))], "Linux")],
    expected: '<Tab title="Linux">\nLinux steps.\n</Tab>\n',
  },
  {
    intent: "card-group",
    name: "grids become card groups with the widest column count",
    children: () => [
      directive(
        "grid",
        [
          directive("grid-item-card", [p(t("Start here."))], "Install", [
            { name: "link", value: "/install" },
          ]),
        ],
        "1 2 2 3",
      ),
    ],
    expected:
      '<CardGroup cols={3}>\n<Card title="Install" href="/install">\nStart here.\n</Card>\n</CardGroup>\n',
  },
  {
    intent: "card",
    name: "a standalone card keeps title and link",
    children: () => [
      directive("card", [p(t("Use validated data."))], "NeMo RL", [
        { name: "link", value: "https://example.com/rl" },
      ]),
    ],
    expected:
      '<Card title="NeMo RL" href="https://example.com/rl">\nUse validated data.\n</Card>\n',
  },
  {
    intent: "framed-image",
    name: "figures become frames with a caption",
    children: () => [
      {
        id: nextId("fig"),
        kind: "figure",
        image: image("/assets/flow.svg", { alt: "Flow" }),
        caption: [t("The flow.")],
        legend: [],
        span,
      },
    ],
    expected:
      '<Frame caption="The flow.">\n  <img src="/assets/flow.svg" alt="Flow" />\n</Frame>\n',
  },
  {
    intent: "image",
    name: "images become Markdown images",
    children: () => [
      image("images/chart (1).png", { title: "Chart" }),
      p(t("Inline "), { id: nextId("iimg"), kind: "inlineImage", source: "icon.png", span }),
    ],
    expected:
      '![chart (1).png](images/chart%20%281%29.png "Chart")\n\nInline ![icon.png](icon.png)\n',
  },
  {
    intent: "diagram",
    name: "mermaid directives become mermaid fences",
    children: () => [directive("mermaid", textBody("graph TD\n  A --> B"))],
    expected: "```mermaid\ngraph TD\n  A --> B\n```\n",
  },
  {
    intent: "math-block",
    name: "display math uses double dollars",
    children: () => [{ id: nextId("math"), kind: "math", value: "E = mc^2", span }],
    expected: "$$\nE = mc^2\n$$\n",
  },
  {
    intent: "math-inline",
    name: "inline math and the math role use single dollars",
    children: () => [
      p(
        t("So "),
        { id: nextId("im"), kind: "inlineMath", value: "a^{2}", span },
        t(" and "),
        role("math", "b_1"),
        t("."),
      ),
    ],
    expected: "So $a^{2}$ and $b_1$.\n",
  },
  {
    intent: "glossary",
    name: "glossary bodies keep their definition list",
    children: () => [
      directive("glossary", [
        {
          id: nextId("dl"),
          kind: "definitionList",
          items: [{ term: [t("IR")], definition: [p(t("Intermediate representation."))] }],
          span,
        },
      ]),
    ],
    expected: "<dl>\n<dt>IR</dt>\n<dd>Intermediate representation.</dd>\n</dl>\n",
  },
  {
    intent: "heading",
    name: "rubrics become third-level headings",
    children: () => [directive("rubric", undefined, "Footnotes #")],
    expected: "### Footnotes \\#\n",
  },
  {
    intent: "titled-block",
    name: "topics become a bold title and their body",
    children: () => [directive("topic", [p(t("Body."))], "Summary")],
    expected: "**Summary**\n\nBody.\n",
  },
  {
    intent: "unwrap",
    name: "containers emit only their body",
    children: () => [
      directive("container", [p(t("Inside."))], undefined, [{ name: "class", value: "wide" }]),
    ],
    expected: "Inside.\n",
  },
  {
    intent: "frontmatter",
    name: "meta descriptions join the plan's frontmatter",
    children: () => [
      directive("meta", undefined, undefined, [
        { name: "description", value: "About GPUs: a guide" },
      ]),
      p(t("Body.")),
    ],
    setup: {
      frontmatter: {
        title: "GPUs",
        slug: "gpus/overview",
        canonicalUrl: "https://docs.example.com/gpus",
      },
    },
    expected:
      '---\ntitle: "GPUs"\nslug: gpus/overview\ndescription: "About GPUs: a guide"\ncanonical-url: "https://docs.example.com/gpus"\n---\n\nBody.\n',
  },
  {
    intent: "anchor",
    name: "labels become anchors unless they name the page",
    children: () => [
      { id: nextId("target"), kind: "target", label: "install-steps", span },
      h(2, t("Install")),
      { id: nextId("target"), kind: "target", label: "page-label", span },
    ],
    setup: {
      labels: [
        { label: "install-steps", documentId: "page", anchor: "install-steps", span },
        { label: "page-label", documentId: "page", span },
      ],
    },
    expected: '<a id="install-steps" />\n\n## Install\n',
  },
  {
    intent: "comment",
    name: "comments become MDX comments",
    children: () => [
      { id: nextId("comment"), kind: "comment", value: "editor note */ here", span },
    ],
    expected: "{/* editor note *\u200b/ here */}\n",
  },
  {
    intent: "html",
    name: "inert HTML stays; other HTML is wrapped",
    children: () => [
      {
        id: nextId("html"),
        kind: "html",
        value: '<iframe src="https://example.com/v" title="Demo"></iframe>',
        span,
      },
      { id: nextId("html"), kind: "html", value: "<div class='x'>a {b} *c*</div>", span },
      p(t("Press "), inlineHtml("<!-- hint -->"), t(" now.")),
    ],
    expected:
      '<iframe src="https://example.com/v" title="Demo"></iframe>\n\n<div dangerouslySetInnerHTML={{ __html: "<div class=\'x\'>a {b} *c*</div>" }} />\n\nPress {/* hint */} now.\n',
  },
  {
    intent: "link",
    name: "button links and download roles become Markdown links",
    children: () => [
      directive("button-link", [p(t("Get started"))], "https://example.com/start"),
      p(
        t("Get "),
        role("download", "the script <scripts/run.sh>", {
          display: "the script",
          target: "scripts/run.sh",
        }),
        t("."),
      ),
    ],
    expected: "[Get started](https://example.com/start)\n\nGet [the script](scripts/run.sh).\n",
  },
  {
    intent: "cross-reference",
    name: "references use display text, then the label title",
    children: () => [
      p(
        role("ref", "Quick Start <quickstart>", { display: "Quick Start", target: "quickstart" }),
        t(" and "),
        role("ref", "install", { target: "install" }),
      ),
    ],
    setup: { labels: [{ label: "install", documentId: "page", title: "Install DocsFab", span }] },
    expected: "[Quick Start](quickstart) and [Install DocsFab](install)\n",
  },
  {
    intent: "inline-code",
    name: "code roles keep backticks in their content",
    children: () => [p(t("Set "), role("envvar", "DOCSFAB_HOME"), t(" or "), role("file", "a`b"))],
    expected: "Set `DOCSFAB_HOME` or ``a`b``\n",
  },
  {
    intent: "strong",
    name: "GUI labels become bold",
    children: () => [p(t("Click "), role("guilabel", "Save *all*"))],
    expected: "Click **Save \\*all\\***\n",
  },
  {
    intent: "keyboard",
    name: "kbd becomes a kbd element",
    children: () => [p(t("Press "), role("kbd", "Ctrl+<C>"))],
    expected: "Press <kbd>Ctrl+&lt;C></kbd>\n",
  },
  {
    intent: "plain-text",
    name: "numref keeps its display text",
    children: () => [
      p(t("See "), role("numref", "Figure %s <fig-a>", { display: "Figure %s", target: "fig-a" })),
    ],
    expected: "See Figure %s\n",
  },
  {
    intent: "badge",
    name: "badges become plain text",
    children: () => [p(t("Status: "), role("bdg-success", "stable"))],
    expected: "Status: stable\n",
  },
  {
    intent: "substitution",
    name: "substitutions resolve from the table and plan rules",
    children: () => [
      p({ id: nextId("sub"), kind: "substitutionReference", name: "product", span }, t(" "), {
        id: nextId("sub"),
        kind: "substitutionReference",
        name: "version",
        span,
      }),
    ],
    setup: {
      substitutions: [
        {
          name: "product",
          value: { kind: "literal", text: "NeMo {RL}" },
          origin: { kind: "configuration", path: "docs/conf.py", span },
        },
        {
          name: "version",
          value: { kind: "computed", expression: "release" },
          origin: { kind: "configuration", path: "docs/conf.py", span },
        },
      ],
      overrides: [
        {
          kind: "substitution",
          name: "version",
          literal: "26.10",
          provenance: { source: "operator" },
        },
      ],
    },
    expected: "NeMo \\{RL\\} 26.10\n",
  },
  {
    intent: "literal-text",
    name: "keep-literal rules and answers become text",
    children: () => [
      p(t("Version "), role("nemo-version", "")),
      { ...directive("product-banner"), id: "banner" },
    ],
    setup: {
      overrides: [
        {
          kind: "construct",
          construct: "role:nemo-version",
          override: { rule: "keep-literal", text: "26.10" },
          provenance: { source: "operator" },
        },
      ],
      answers: [["unit:node:banner", { answer: "keep-literal", text: "NVIDIA <NeMo>" }]],
    },
    expected: "Version 26.10\n\nNVIDIA &lt;NeMo>\n",
  },
];

describe("Fern page emitter goldens", () => {
  it.each(GOLDEN.map((golden) => [`${golden.intent}: ${golden.name}`, golden] as const))(
    "golden %s",
    (_title, golden) => {
      expect(pageText(golden.children(), golden.setup)).toBe(golden.expected);
    },
  );

  it("has a golden case for every intent it emits", () => {
    const covered = new Set(GOLDEN.map((golden) => golden.intent));
    expect(FERN_EMITTED_INTENTS.filter((intent) => !covered.has(intent))).toEqual([]);
  });
});

const html = (value: string): ConversionBlock => ({
  id: nextId("html"),
  kind: "html",
  value,
  span,
});
const figure = (
  source: string,
  caption: ConversionInline[],
  options: Parameters<typeof image>[1] = {},
): ConversionBlock => ({
  id: nextId("fig"),
  kind: "figure",
  image: image(source, options),
  caption,
  legend: [],
  span,
});
const literalInclude = (
  path: string,
  extra: Partial<Extract<ConversionBlock, { kind: "include" }>>,
): ConversionBlock => ({
  id: nextId("inc"),
  kind: "include",
  mode: "literal",
  target: { kind: "local", path },
  other: [],
  ...extra,
  span,
});
const SAMPLE_PY =
  'import os\n\n\ndef greet(name):\n    return f"Hello, {name}"\n\n\ndef unused():\n    return os.sep\n';
const simpleTable = (header: string[], ...body: string[][]): ConversionBlock => ({
  id: nextId("table"),
  kind: "table",
  headerRows: [{ cells: header.map((cell) => ({ children: [p(t(cell))] })) }],
  bodyRows: body.map((row) => ({ cells: row.map((cell) => ({ children: [p(t(cell))] })) })),
  span,
});

interface CorpusCase {
  /** A conversion-v1 corpus case id (MR !1663); `expected` is its docsfabExpectation output. */
  caseId: string;
  children: () => ConversionBlock[];
  setup?: PageSetup;
  /** Legacy fragments without a final newline gain the page's one trailing newline. */
  expected: string;
}

/**
 * Corpus cases whose expected output the page emitter alone produces from
 * hand-built IR. Image and link targets are written as route planning
 * supplies them; titles come from the plan's frontmatter, and the source
 * title policy has already removed a title-only H1 from the IR.
 */
const CORPUS_CASES: CorpusCase[] = [
  {
    caseId: "probe.myst-code-block-caption-emphasize-lines.01",
    children: () => [
      h(1, t("Page")),
      codeBlock("import os\nprint(os.sep)", "python", {
        caption: "example.py",
        emphasizeLines: [{ start: 2, end: 2 }],
      }),
    ],
    expected: '# Page\n\n```python title="example.py" {2}\nimport os\nprint(os.sep)\n```\n',
  },
  {
    caseId: "probe.rst-code-block-caption-emphasize-lines.01",
    children: () => [
      codeBlock("import os\nprint(os.sep)", "python", {
        caption: "example.py",
        emphasizeLines: [{ start: 2, end: 2 }],
      }),
    ],
    setup: { frontmatter: { title: "Page" } },
    expected:
      '---\ntitle: "Page"\n---\n\n```python title="example.py" {2}\nimport os\nprint(os.sep)\n```\n',
  },
  {
    caseId: "probe.rst-csv-table-quoting.01",
    children: () => [
      directive("csv-table", textBody('"Smith, J", "Says ""hi"""'), undefined, [
        { name: "header", value: '"Name", "Notes"' },
      ]),
    ],
    setup: { frontmatter: { title: "Table" } },
    expected:
      '---\ntitle: "Table"\n---\n\n| Name | Notes |\n| --- | --- |\n| Smith, J | Says "hi" |\n',
  },
  {
    caseId: "probe.myst-literalinclude-lines.01",
    children: () => [
      literalInclude("sample.py", { language: "python", lines: [{ start: 4, end: 5 }] }),
    ],
    setup: { sources: files({ "sample.py": SAMPLE_PY }) },
    expected: '```python\ndef greet(name):\n    return f"Hello, {name}"\n```\n',
  },
  {
    caseId: "probe.myst-literalinclude-pyobject.01",
    children: () => [literalInclude("sample.py", { language: "python", pyobject: "greet" })],
    setup: { sources: files({ "sample.py": SAMPLE_PY }) },
    expected: '```python\ndef greet(name):\n    return f"Hello, {name}"\n```\n',
  },
  {
    caseId: "converters.convertfigure-test-basic-caption.01",
    children: () => [
      figure(
        "/assets/images/usage/experiment-details.png",
        [t("The Experiments Dashboard showing experiment history and results.")],
        { alt: "Architecture" },
      ),
    ],
    expected:
      '<Frame caption="The Experiments Dashboard showing experiment history and results.">\n  <img src="/assets/images/usage/experiment-details.png" alt="Architecture" />\n</Frame>\n',
  },
  {
    caseId: "converters.convertfigure-test-no-caption.01",
    children: () => [figure("/assets/images/foo.png", [], { alt: "Foo" })],
    expected: '<Frame>\n  <img src="/assets/images/foo.png" alt="Foo" />\n</Frame>\n',
  },
  {
    caseId: "converters.convertfigure-test-multiline-caption.01",
    children: () => [
      figure("/assets/images/diagram.svg", [t("First line of caption.\nSecond line of caption.")], {
        width: "80%",
        align: "center",
      }),
    ],
    expected:
      '<Frame caption="First line of caption. Second line of caption.">\n  <img src="/assets/images/diagram.svg" alt="diagram.svg" />\n</Frame>\n',
  },
  {
    caseId: "converters.convertfigure-test-four-colon-fence.01",
    children: () => [figure("/assets/images/arch.png", [t("Caption here.")], { alt: "Test" })],
    expected:
      '<Frame caption="Caption here.">\n  <img src="/assets/images/arch.png" alt="Test" />\n</Frame>\n',
  },
  {
    caseId: "converters.convertfigure-test-static-non-image-path.01",
    children: () => [figure("/assets/static/diagrams/flow.svg", [t("Flow diagram.")])],
    expected:
      '<Frame caption="Flow diagram.">\n  <img src="/assets/static/diagrams/flow.svg" alt="flow.svg" />\n</Frame>\n',
  },
  {
    caseId: "converters.convertimagedirective-test-static-images-path.01",
    children: () => [image("/assets/images/logo.png", { alt: "Logo" })],
    expected: "![Logo](/assets/images/logo.png)\n",
  },
  {
    caseId: "converters.convertimagedirective-test-images-prefix.01",
    children: () => [image("/assets/images/chart.png")],
    expected: "![chart.png](/assets/images/chart.png)\n",
  },
  {
    caseId: "converters.convertimagedirective-test-plain-path-unchanged.01",
    children: () => [image("assets/photo.jpg", { alt: "Photo" })],
    expected: "![Photo](assets/photo.jpg)\n",
  },
  {
    caseId: "converters.colonfenceadmonitions-test-explicit-close.01",
    children: () => [directive("admonition", [p(t("Body"))], "Title")],
    expected: '<Accordion title="Title">\nBody\n</Accordion>\n',
  },
  {
    caseId: "converters.colonfenceadmonitions-test-two-adjacent-admonitions.01",
    children: () => [
      directive("admonition", [p(t("Body one."))], "First"),
      directive("admonition", [p(t("Body two."))], "Second"),
    ],
    expected:
      '<Accordion title="First">\nBody one.\n</Accordion>\n<Accordion title="Second">\nBody two.\n</Accordion>\n',
  },
  {
    caseId:
      "converters.longbacktickdirectives-test-nested-tab-set-and-items-close-by-fence-length.01",
    children: () => [
      directive("tab-set", [
        directive("tab-item", [p(t("One."))], "First"),
        directive("tab-item", [p(t("Two."))], "Second"),
      ]),
    ],
    expected:
      '<Tabs>\n<Tab title="First">\nOne.\n</Tab>\n<Tab title="Second">\nTwo.\n</Tab>\n</Tabs>\n',
  },
  {
    caseId: "convert-callouts.multiline-test-multiline-content.01",
    children: () => [directive("note", [p(t("Line one.\nLine two."))])],
    expected: "<Note>\nLine one.\nLine two.\n</Note>\n",
  },
  {
    caseId: "convert-callouts.multiline-test-multiline-ends-at-blank.01",
    children: () => [directive("note", [p(t("Line one.\nLine two."))]), p(t("After."))],
    expected: "<Note>\nLine one.\nLine two.\n</Note>\n\nAfter.\n",
  },
  {
    caseId: "convert-rst-to-mdx.idempotentfrontmatter-test-double-convert-is-noop.01",
    children: () => [p(t("Some body text with a paragraph."))],
    setup: { frontmatter: { title: "Page Title" } },
    expected: '---\ntitle: "Page Title"\n---\n\nSome body text with a paragraph.\n',
  },
  {
    caseId: "convert-rst-to-mdx.idempotentfrontmatter-test-title-not-nested.01",
    children: () => [p(t("Body."))],
    setup: { frontmatter: { title: "fq2bam (BWA-MEM + GATK)" } },
    expected: '---\ntitle: "fq2bam (BWA-MEM + GATK)"\n---\n\nBody.\n',
  },
  {
    caseId: "convert-rst-to-mdx.idempotentfrontmatter-test-idempotent-with-constructs.01",
    children: () => [
      p(t("Intro paragraph.")),
      directive("note", [p(t("Be careful."))]),
      p(t("Run this:")),
      codeBlock("ls -la"),
      list(true, [item(p(t("First"))), item(p(t("Second")))]),
    ],
    setup: { frontmatter: { title: "Title Here" } },
    expected:
      '---\ntitle: "Title Here"\n---\n\nIntro paragraph.\n\n<Note>\nBe careful.\n</Note>\n\nRun this:\n\n```\nls -la\n```\n\n1. First\n2. Second\n',
  },
  {
    caseId: "convert-rst-to-mdx.idempotentfrontmatter-test-idempotent-with-math.01",
    children: () => [{ id: nextId("math"), kind: "math", value: "E = mc^2", span }],
    setup: { frontmatter: { title: "Eq" } },
    expected: '---\ntitle: "Eq"\n---\n\n$$\nE = mc^2\n$$\n',
  },
  {
    caseId: "convert-rst-to-mdx.headingsnotmistakenforfences-test-backtick-underlined-heading.01",
    children: () => [h(2, t("Section")), p(t("Body."))],
    setup: { frontmatter: { title: "Page" } },
    expected: '---\ntitle: "Page"\n---\n\n## Section\n\nBody.\n',
  },
  {
    caseId:
      "convert-rst-to-mdx.headingsnotmistakenforfences-test-idempotent-with-tilde-headings.01",
    children: () => [h(2, t("Sub A")), p(t("Text A.")), h(2, t("Sub B")), p(t("Text B."))],
    setup: { frontmatter: { title: "Top" } },
    expected: '---\ntitle: "Top"\n---\n\n## Sub A\n\nText A.\n\n## Sub B\n\nText B.\n',
  },
  {
    caseId: "convert-rst-to-mdx.stripdirectivebodies-test-todo-body-dropped.01",
    children: () => [
      directive("todo", [p(t("Put links in the above paragraph."))]),
      p(t("Real content.")),
    ],
    setup: { frontmatter: { title: "Intro" } },
    expected: '---\ntitle: "Intro"\n---\n\nReal content.\n',
  },
  {
    caseId: "convert-rst-to-mdx.stripdirectivebodies-test-spelling-wordlist-dropped.01",
    children: () => [
      directive("spelling:word-list", textBody("Nextflow\nGPU")),
      p(t("Body text.")),
    ],
    setup: { frontmatter: { title: "Intro" } },
    expected: '---\ntitle: "Intro"\n---\n\nBody text.\n',
  },
  {
    caseId: "convert-rst-to-mdx.multilineref-test-two-line-ref-resolved.01",
    children: () => [
      p(
        t("See "),
        role("ref", "a software tool for speeding up DNA and RNA\nanalysis. <what_is_it>", {
          display: "a software tool for speeding up DNA and RNA\nanalysis.",
          target: "/what_is_it",
        }),
        t(" for details."),
      ),
    ],
    setup: { frontmatter: { title: "Intro" } },
    expected:
      '---\ntitle: "Intro"\n---\n\nSee [a software tool for speeding up DNA and RNA analysis.](/what_is_it) for details.\n',
  },
  {
    caseId: "convert-rst-to-mdx.multilineref-test-single-line-ref-still-works.01",
    children: () => [
      p(
        t("See "),
        role("ref", "Quick Start <quickstart>", { display: "Quick Start", target: "/quickstart" }),
        t(" page."),
      ),
    ],
    setup: { frontmatter: { title: "Intro" } },
    expected: '---\ntitle: "Intro"\n---\n\nSee [Quick Start](/quickstart) page.\n',
  },
  {
    caseId: "convert-rst-to-mdx.literalblockdedent-test-dedented-preprocessor-stays-in-fence.01",
    children: () => [
      p(t("Loop fission:")),
      codeBlock(
        "    int main() {\n#ifdef SIMD\n    do_simd();\n#else\n    do_scalar();\n#endif\n        return 0;\n    }",
      ),
      p(t("Done.")),
    ],
    setup: { frontmatter: { title: "Example" } },
    expected:
      '---\ntitle: "Example"\n---\n\nLoop fission:\n\n```\n    int main() {\n#ifdef SIMD\n    do_simd();\n#else\n    do_scalar();\n#endif\n        return 0;\n    }\n```\n\nDone.\n',
  },
  {
    caseId: "convert-rst-to-mdx.gridtablecentered-test-centered-cells-converted.01",
    children: () => [simpleTable(["GPU", "Tool"], ["A100", "fq2bam"]), p(t("End."))],
    setup: { frontmatter: { title: "Bench" } },
    expected:
      '---\ntitle: "Bench"\n---\n\n| GPU | Tool |\n| --- | --- |\n| A100 | fq2bam |\n\nEnd.\n',
  },
  {
    caseId:
      "convert-rst-to-mdx.codeblocksubstitutions-test-pipe-token-untouched-without-substitutions-flag.01",
    children: () => [codeBlock("docker pull |docker_image|", "sh")],
    setup: { frontmatter: { title: "Pull" } },
    expected: '---\ntitle: "Pull"\n---\n\n```sh\ndocker pull |docker_image|\n```\n',
  },
  {
    caseId: "convert-rst-to-mdx.hyperlinks-test-named-target-and-reference.01",
    children: () => [p(t("See "), link("https://www.python.org", t("Python")), t(" for more."))],
    setup: { frontmatter: { title: "Page" } },
    expected: '---\ntitle: "Page"\n---\n\nSee [Python](https://www.python.org) for more.\n',
  },
  {
    caseId: "convert-rst-to-mdx.hyperlinks-test-bare-name-reference.01",
    children: () => [p(t("Read "), link("https://docs.example.com", t("Docs")), t(" now."))],
    setup: { frontmatter: { title: "Page" } },
    expected: '---\ntitle: "Page"\n---\n\nRead [Docs](https://docs.example.com) now.\n',
  },
  {
    caseId: "convert-rst-to-mdx.hyperlinks-test-bare-snake-case-reference.01",
    children: () => [
      p(t("See "), link("https://example.com/s", t("my_section")), t(" for details.")),
    ],
    setup: { frontmatter: { title: "Page" } },
    expected: '---\ntitle: "Page"\n---\n\nSee [my_section](https://example.com/s) for details.\n',
  },
  {
    caseId: "convert-rst-to-mdx.hyperlinks-test-plain-identifier-with-underscore-untouched.01",
    children: () => [p(t("The foo_bar variable and value_ here."))],
    setup: { frontmatter: { title: "Page" } },
    expected: '---\ntitle: "Page"\n---\n\nThe foo_bar variable and value_ here.\n',
  },
  {
    caseId: "convert-rst-to-mdx.hyperlinks-test-inline-external-link.01",
    children: () => [p(t("See "), link("https://example.com", t("the site")), t(" now."))],
    setup: { frontmatter: { title: "Page" } },
    expected: '---\ntitle: "Page"\n---\n\nSee [the site](https://example.com) now.\n',
  },
  {
    caseId: "mdx-patterns.test-escape-bare-lt-digit.01",
    children: () => [p(t("under <100ms."))],
    expected: "under &lt;100ms.\n",
  },
  {
    caseId: "mdx-patterns.test-escape-skips-inside-inline-code.01",
    children: () => [p(t("see "), code("<4096>"), t("."))],
    expected: "see `<4096>`.\n",
  },
  {
    caseId: "mdx-patterns.test-escape-skips-inside-fence.01",
    children: () => [codeBlock("threshold = '<4096'")],
    expected: "```\nthreshold = '<4096'\n```\n",
  },
  {
    caseId: "mdx-patterns.test-escape-autolinks.01",
    children: () => [
      p(t("See "), link("https://example.com/path", t("https://example.com/path")), t(".")),
    ],
    expected: "See [https://example.com/path](https://example.com/path).\n",
  },
  {
    caseId: "mdx-patterns.test-escape-autolinks-skips-inline-code.01",
    children: () => [p(t("Literal "), code("<https://example.com/path>"), t("."))],
    expected: "Literal `<https://example.com/path>`.\n",
  },
  {
    caseId: "mdx-patterns.test-wrap-style-block-with-css-braces.01",
    children: () => [html("<style>\n  .x { color: red; }\n</style>")],
    expected: "<style>{`\n  .x { color: red; }\n`}</style>\n",
  },
  {
    caseId: "mdx-patterns.test-wrap-skips-style-mention-inside-inline-code.01",
    children: () => [
      h(2, t("The "), code("<style>"), t(" tag")),
      html("<style>\n  .x { color: red; }\n</style>"),
    ],
    expected: "## The `<style>` tag\n\n<style>{`\n  .x { color: red; }\n`}</style>\n",
  },
  {
    caseId: "mdx-patterns.test-wrap-skips-style-inside-fence.01",
    children: () => [codeBlock("<style>body { x }</style>", "html")],
    expected: "```html\n<style>body { x }</style>\n```\n",
  },
  {
    caseId: "convert-html-comments-to-mdx.test-multiline-comment.01",
    children: () => [p(t("x "), inlineHtml("<!-- line1\nline2 -->"), t(" y"))],
    expected: "x {/* line1\nline2 */} y\n",
  },
  {
    caseId: "convert-html-comments-to-mdx.test-escapes-jsx-comment-terminator-in-body.01",
    children: () => [html("<!-- a */ b -->")],
    expected: "{/* a *​/ b */}\n",
  },
];

describe("conversion-v1 corpus cases the Fern page emitter owns", () => {
  it.each(CORPUS_CASES.map((corpus) => [corpus.caseId, corpus] as const))(
    "corpus case %s",
    (_id, corpus) => {
      expect(pageText(corpus.children(), corpus.setup)).toBe(corpus.expected);
    },
  );
});

describe("Fern emitter safety regressions", () => {
  it("reports unsupported card link types instead of emitting a broken href", () => {
    const result = emit([
      directive("card", [p(t("Read"))], "Reference", [
        { name: "link", value: "guide/page" },
        { name: "link-type", value: "doc" },
      ]),
    ]);
    expect(result.status).toBe("emitted");
    if (result.status === "emitted") {
      expect(result.notices).toContainEqual(
        expect.objectContaining({
          code: "option-not-emitted",
          detail: expect.stringContaining("link-type"),
        }),
      );
      expect(result.notices).toContainEqual(
        expect.objectContaining({
          code: "option-not-emitted",
          detail: expect.stringContaining("link target"),
        }),
      );
      expect(result.text).not.toContain('href="guide/page"');
    }
  });

  it("keeps pipe characters safe in GFM table link destinations", () => {
    const table = simpleTable(["Link"], [""]);
    const row = table.kind === "table" ? table.bodyRows[0] : undefined;
    const cell = row?.cells[0];
    expect(cell).toBeDefined();
    if (cell !== undefined) cell.children = [p(link("https://example.test/a|b", t("Guide")))];
    const result = pageText([table]);
    expect(result).toContain("https://example.test/a%7Cb");
  });

  it("maps footnote labels injectively while preserving valid dots", () => {
    const result = pageText([
      p(t("A"), { id: nextId("ref"), kind: "footnoteReference", label: "a.b", span }),
      p(t("B"), { id: nextId("ref"), kind: "footnoteReference", label: "a-b", span }),
      p(t("C"), { id: nextId("ref"), kind: "footnoteReference", label: "A", span }),
      p(t("D"), { id: nextId("ref"), kind: "footnoteReference", label: "a", span }),
      { id: nextId("fn"), kind: "footnoteDefinition", label: "a.b", children: [p(t("One"))], span },
      { id: nextId("fn"), kind: "footnoteDefinition", label: "a-b", children: [p(t("Two"))], span },
      { id: nextId("fn"), kind: "footnoteDefinition", label: "A", children: [p(t("Three"))], span },
      { id: nextId("fn"), kind: "footnoteDefinition", label: "a", children: [p(t("Four"))], span },
    ]);
    expect(result).toContain("[^a.b]");
    expect(result).toContain("[^a-b]");
    expect(result).toContain("[^a.b]: One");
    expect(result).toContain("[^a-b]: Two");
    expect(result).toContain("[^_u41_]");
    expect(result).toContain("[^a]");
    expect(result).toContain("[^_u41_]: Three");
    expect(result).toContain("[^a]: Four");
  });

  it("notices source frontmatter keys while using the explicit page plan", () => {
    const ir = irOf([p(t("Body"))]);
    const root = ir.documents[0] as ConversionDocument;
    (root as { frontmatter: Record<string, unknown> }).frontmatter = {
      description: "source text",
      keywords: ["x"],
    };
    resolveConversionIr(ir);
    const result = emitFernPage({
      ir,
      documentId: "page",
      rules: buildConstructRuleIndex(CONSTRUCT_RULE_REGISTRY),
      frontmatter: { title: "Planned title" },
    });
    expect(result.status).toBe("emitted");
    expect(result.notices.map((notice) => notice.detail)).toEqual([
      "Source frontmatter key description is not consumed by the page plan.",
      "Source frontmatter key keywords is not consumed by the page plan.",
    ]);
    if (result.status === "emitted") expect(result.text).toContain('title: "Planned title"');
  });

  it("quotes YAML numeric-looking slug strings", () => {
    const result = pageText([p(t("Body"))], { frontmatter: { slug: "1e3" } });
    expect(result).toContain('slug: "1e3"');
    const radix = pageText([p(t("Body"))], { frontmatter: { slug: "0x10" } });
    expect(radix).toContain('slug: "0x10"');
  });

  it("turns a final checker failure into a named page refusal", () => {
    const checker = vi
      .spyOn(fernMdxCheck, "checkFernMdx")
      .mockReturnValue([{ code: "esm-block", line: 1, detail: "import Widget" }]);
    try {
      const result = emit([p(t("Safe"))]);
      expect(result.status).toBe("refused");
      if (result.status === "refused") {
        expect(result.refusals).toEqual([
          expect.objectContaining({
            code: "fern-mdx-unsafe",
            message: expect.stringContaining("esm-block"),
          }),
        ]);
      }
    } finally {
      checker.mockRestore();
    }
  });
});

const INLINE_NODE_KINDS = new Set([
  "text",
  "emphasis",
  "strong",
  "inlineCode",
  "link",
  "inlineImage",
  "inlineHtml",
  "inlineMath",
  "lineBreak",
  "footnoteReference",
  "substitutionReference",
]);

describe("Fern intent coverage", () => {
  it("gives every convert rule in the registry an emitter of the form its construct needs", () => {
    const missing: string[] = [];
    for (const { construct, rule } of CONSTRUCT_RULE_REGISTRY.rules) {
      if (rule.disposition !== "convert") continue;
      const emitter = Object.hasOwn(FERN_INTENT_EMITTERS, rule.convert.target)
        ? FERN_INTENT_EMITTERS[rule.convert.target]
        : undefined;
      const [family = "", name = ""] = construct.split(/:(.*)/su);
      const inline = family === "role" || (family === "node" && INLINE_NODE_KINDS.has(name));
      const form = inline ? emitter?.inline : emitter?.block;
      if (form === undefined) missing.push(`${construct} -> ${rule.convert.target}`);
    }
    expect(missing).toEqual([]);
  });

  it("refuses an intent the emitter table does not know with a named code", () => {
    const registry = {
      version: CONSTRUCT_RULE_REGISTRY.version,
      rules: CONSTRUCT_RULE_REGISTRY.rules.map((rule) =>
        rule.construct === "directive:note"
          ? { ...rule, rule: { disposition: "convert", convert: { target: "sparkle" } } }
          : rule,
      ),
    } as unknown as typeof CONSTRUCT_RULE_REGISTRY;
    const note = { ...directive("note", [p(t("x"))]), id: "note" };
    const result = emitFernPage({
      ir: irOf([note]),
      documentId: "page",
      rules: buildConstructRuleIndex(registry),
    });
    expect(result.status).toBe("refused");
    expect(result.status === "refused" && result.refusals).toEqual([
      expect.objectContaining({ code: "fern-intent-unknown", nodeId: "note" }),
    ]);
  });
});

/** The same value with every object's keys in reverse order. */
function reverseKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(reverseKeys) as T;
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, entry]) => [key, reverseKeys(entry)]),
  ) as T;
}

describe("Fern page determinism", () => {
  it("emits identical bytes for the same IR regardless of object key order", () => {
    const children = GOLDEN.flatMap((golden) =>
      golden.setup === undefined ? golden.children() : [],
    );
    const ir = irOf(children);
    const rules = buildConstructRuleIndex();
    const frontmatter = { title: "Everything", slug: "all", canonicalUrl: "https://x.test/all" };
    const first = emitFernPage({ ir, documentId: "page", rules, frontmatter });
    const second = emitFernPage({
      ir: reverseKeys(ir),
      documentId: "page",
      rules,
      frontmatter: reverseKeys(frontmatter),
    });
    expect(first.status).toBe("emitted");
    expect(second).toEqual(first);
    if (first.status !== "emitted") return;
    expect(first.text.endsWith("\n") && !first.text.endsWith("\n\n")).toBe(true);
    expect(first.text).not.toMatch(/\r/u);
    expect(
      first.text.startsWith(
        '---\ntitle: "Everything"\nslug: all\ncanonical-url: "https://x.test/all"\n---\n\n',
      ),
    ).toBe(true);
  });
});

function refusalsOf(result: FernPageResult): Array<{ code: string; nodeId?: string }> {
  expect(result.status).toBe("refused");
  return result.status === "refused"
    ? result.refusals.map(({ code, nodeId }) => ({
        code,
        ...(nodeId === undefined ? {} : { nodeId }),
      }))
    : [];
}

describe("Fern page refusals", () => {
  it("keeps toctree bodies in navigation and refuses page-body overrides", () => {
    const toc = {
      ...directive("toctree", {
        kind: "toctree",
        entries: [{ kind: "document", target: "guide", span }],
        hidden: false,
        glob: false,
      }),
      id: "toc",
    };
    const navigationEntry = {
      kind: "page" as const,
      documentId: "guide",
      title: { text: "Guide", origin: "toctree-entry" as const },
      hidden: false,
    };
    const ir = irOf([toc]);
    ir.navigation.entries.push(navigationEntry);
    const resolution = resolveConversionIr(ir);
    const emitted = emitFernPage({
      ir,
      documentId: "page",
      rules: buildConstructRuleIndex(),
    });

    expect(resolution.dropLedger).toContainEqual(
      expect.objectContaining({
        nodeId: "toc",
        reason: expect.objectContaining({ code: "navigation-owned" }),
      }),
    );
    expect(emitted.status).toBe("emitted");
    if (emitted.status === "emitted") expect(emitted.text).not.toContain("guide");
    expect(ir.navigation.entries).toEqual([navigationEntry]);

    const forced = emit([toc], {
      overrides: [
        {
          kind: "construct",
          construct: "directive:toctree",
          override: { rule: "map-to-construct", construct: "directive:div" },
          provenance: { source: "operator" },
        },
      ],
    });
    expect(refusalsOf(forced)).toEqual([{ code: "fern-intent-node-mismatch", nodeId: "toc" }]);
  });

  it("reports every node it cannot write instead of skipping it", () => {
    const custom = { ...directive("product-banner"), id: "custom" };
    const api = { ...directive("automodule", undefined, "pkg"), id: "api" };
    const include = { ...literalInclude("missing.py", {}), id: "include" };
    const csv = {
      ...directive("csv-table", undefined, undefined, [
        { name: "url", value: "https://x.test/a.csv" },
      ]),
      id: "csv",
    };
    const substitution: ConversionInline = {
      id: "sub",
      kind: "substitutionReference",
      name: "release",
      span,
    };
    const result = emit([custom, api, include, csv, p(substitution)], {
      substitutions: [
        {
          name: "release",
          value: { kind: "computed", expression: "version" },
          origin: { kind: "configuration", path: "docs/conf.py", span },
        },
      ],
    });
    expect(refusalsOf(result)).toEqual([
      { code: "fern-node-unresolved", nodeId: "custom" },
      { code: "fern-node-refused", nodeId: "api" },
      { code: "fern-source-missing", nodeId: "include" },
      { code: "fern-source-remote", nodeId: "csv" },
      { code: "fern-substitution-unresolved", nodeId: "sub" },
    ]);
    if (result.status === "refused") {
      for (const refusal of result.refusals) expect(refusal.nextAction).not.toBe("");
    }
  });

  it("refuses a markup include cycle", () => {
    const loop = (): ConversionBlock => ({
      id: nextId("inc"),
      kind: "include",
      mode: "markup",
      target: { kind: "local", path: "page.md" },
      other: [],
      span,
    });
    const result = emit([loop()], { sources: { document: () => document([loop()], "page") } });
    expect(refusalsOf(result).map((refusal) => refusal.code)).toEqual(["fern-include-cycle"]);
  });

  it("refuses an include selection the file cannot satisfy", () => {
    const result = emit([literalInclude("sample.py", { pyobject: "missing" })], {
      sources: files({ "sample.py": SAMPLE_PY }),
    });
    expect(refusalsOf(result).map((refusal) => refusal.code)).toEqual([
      "fern-include-selection-failed",
    ]);
  });

  it("refuses an unknown document", () => {
    const result = emitFernPage({
      ir: irOf([]),
      documentId: "nope",
      rules: buildConstructRuleIndex(),
    });
    expect(refusalsOf(result)).toEqual([{ code: "fern-document-unknown" }]);
  });

  it("applies drop and map-to-construct answers to judged nodes", () => {
    const dropped = { ...directive("product-banner", [p(t("x"))]), id: "dropped" };
    const mapped = { ...directive("callout-box", [p(t("Careful."))], "Heads up"), id: "mapped" };
    const result = emit([dropped, mapped], {
      answers: [
        ["unit:node:dropped", { answer: "drop", reason: "Marketing banner." }],
        [
          "unit:node:mapped",
          {
            answer: "map-to-construct",
            construct: "directive:note",
            parameters: { target: "callout", tone: "warning", title: "argument" },
          },
        ],
      ],
    });
    expect(result).toMatchObject({
      status: "emitted",
      text: '<Warning title="Heads up">\nCareful.\n</Warning>\n',
      notices: [{ code: "answer-drop", nodeId: "dropped", detail: "Marketing banner." }],
    });
  });
});

describe("Fern page notices", () => {
  it("records source detail Fern cannot carry", () => {
    const block = {
      ...codeBlock("x", "python", { lineNumbers: true, other: [{ name: "dedent", value: "2" }] }),
      id: "code",
    };
    const img = { ...image("a.png", { width: "50%" }), id: "img" };
    const deep = { ...h(8, t("Deep")), id: "deep" };
    const raw = { ...html("<p>a<br>b</p>"), id: "raw" };
    const fig: ConversionBlock = {
      id: "fig",
      kind: "figure",
      image: image("b.png"),
      caption: [t("A "), em(t("styled"))],
      legend: [],
      span,
    };
    const result = emit([block, img, deep, raw, fig]);
    expect(result.status).toBe("emitted");
    expect(result.notices.map(({ code, nodeId }) => `${code}:${nodeId}`)).toEqual([
      "attribute-not-emitted:code",
      "option-not-emitted:code",
      "option-not-emitted:img",
      "heading-depth-clipped:deep",
      "html-wrapped:raw",
      "caption-flattened:fig",
    ]);
    expect(result.status === "emitted" && result.text).toContain("###### Deep\n");
  });
});

describe("Fern literal include selection", () => {
  const MODULE = [
    "class Client:",
    '    """Talks to the service."""',
    "",
    "    @property",
    "    def name(self):",
    '        return "client"',
    "",
    "    def close(self):",
    "        pass",
    "",
    "# start here",
    "VALUE = 1",
    "# end here",
    "",
  ].join("\n");
  const included = (extra: Partial<Extract<ConversionBlock, { kind: "include" }>>): string =>
    pageText([literalInclude("client.py", { language: "python", ...extra })], {
      sources: files({ "client.py": MODULE }),
    });

  it("selects a method by dotted name with its decorator", () => {
    expect(included({ pyobject: "Client.name" })).toBe(
      '```python\n    @property\n    def name(self):\n        return "client"\n```\n',
    );
  });

  it("selects between start-after and end-before markers", () => {
    expect(included({ startAfter: "start here", endBefore: "end here" })).toBe(
      "```python\nVALUE = 1\n```\n",
    );
  });

  it("notes lines past the end of the file instead of hiding them", () => {
    const result = emit([literalInclude("client.py", { lines: [{ start: 12, end: 40 }] })], {
      sources: files({ "client.py": MODULE }),
    });
    expect(result).toMatchObject({
      status: "emitted",
      text: "```\nVALUE = 1\n# end here\n```\n",
      notices: [{ code: "include-lines-beyond-end" }],
    });
  });

  it("refuses CSV that RFC 4180 cannot parse", () => {
    const result = emit([directive("csv-table", textBody('"open, quote'))]);
    expect(refusalsOf(result).map((refusal) => refusal.code)).toEqual(["fern-table-shape-invalid"]);
  });
});
