// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Setext headings, thematic breaks, and the coded stops for page anchors the
 * content index cannot admit.
 *
 * A `---` or `===` line underlines a setext heading only when the line above
 * it is paragraph text. On a target page, any anchor that still normalizes to
 * nothing, or that the page defines twice, stops with a catalogued code whose
 * message names the page, the line, and the edit. On any other page it is
 * recorded instead (test/content-ir-index-limitations.test.ts).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildContentIndex,
  ContentIndexError,
  PAGE_ANCHOR_NEXT_ACTIONS,
} from "../src/content-ir/index.js";
import type { ContentIndexV1, DocumentNode, SectionNode } from "../src/content-ir/index.js";
import {
  DEFAULT_DOCS_ANCHORS,
  DEFAULT_NEXT_ACTIONS,
  formatOperatorErrorEnvelope,
  toOperatorErrorEnvelope,
} from "../src/operator/error-envelope.js";
import { classifyThrownFailure } from "../src/operator/failure-classification.js";
import { temporaryRoots } from "./helpers/temp.js";

const REVISION = "a".repeat(40);
const LIVE_AGENT_TROUBLESHOOTING = "docs/troubleshooting.md";
const roots = temporaryRoots();

async function indexPage(
  contents: string,
  page = "README.md",
  targetPaths?: readonly string[],
): Promise<ContentIndexV1> {
  const repositoryPath = await roots.create("docsfab-content-ir-page-anchors-");
  await mkdir(dirname(join(repositoryPath, page)), { recursive: true });
  await writeFile(join(repositoryPath, page), contents, "utf8");
  return buildContentIndex({
    repositoryPath,
    repositoryRevision: REVISION,
    ...(targetPaths ? { targetPaths } : {}),
  });
}

/** Indexes the page as a target, where an anchor problem stops the index. */
async function refusal(contents: string, page = "README.md"): Promise<ContentIndexError> {
  try {
    await indexPage(contents, page, [page]);
  } catch (error) {
    expect(error).toBeInstanceOf(ContentIndexError);
    return error as ContentIndexError;
  }
  throw new Error(`Expected the content index to refuse ${page}, but it indexed the page.`);
}

function sections(index: ContentIndexV1, page = "README.md") {
  return index.nodes
    .filter((node): node is SectionNode => node.kind === "section" && node.sourcePath === page)
    .sort((left, right) => left.startLine - right.startLine)
    .map(({ anchor, depth, startLine }) => ({ anchor, depth, startLine }));
}

function document(index: ContentIndexV1, page = "README.md"): DocumentNode {
  const found = index.nodes.find(
    (node): node is DocumentNode => node.kind === "document" && node.sourcePath === page,
  );
  if (!found) throw new Error(`The index has no document node for ${page}.`);
  return found;
}

describe("setext underlines and thematic breaks", () => {
  it("reads --- after a closing backtick fence as a thematic break", async () => {
    const index = await indexPage(
      [
        "# Guide",
        "",
        "Intro paragraph.",
        "",
        "```bash",
        "echo ready",
        "```",
        "---",
        "",
        "## Next",
        "",
      ].join("\n"),
    );
    expect(sections(index)).toEqual([
      { anchor: "guide", depth: 1, startLine: 1 },
      { anchor: "next", depth: 2, startLine: 10 },
    ]);
    expect(document(index).codeBlocks).toEqual([{ language: "bash", startLine: 5, endLine: 7 }]);
  });

  it("reads === after a longer closing tilde fence with an info string as a thematic break", async () => {
    const index = await indexPage(
      [
        "# Tilde",
        "",
        '~~~~ yaml title="config"',
        "key: value",
        "~~~",
        "still: code",
        "~~~~",
        "===",
        "",
        "Tail paragraph.",
        "",
      ].join("\n"),
    );
    expect(sections(index)).toEqual([{ anchor: "tilde", depth: 1, startLine: 1 }]);
    expect(document(index).codeBlocks).toEqual([{ language: "yaml", startLine: 3, endLine: 7 }]);
  });

  it("keeps setext H1 and H2 headings that underline paragraph text", async () => {
    const index = await indexPage(
      [
        "Overview",
        "========",
        "",
        "Body text.",
        "",
        "Details",
        "-------",
        "",
        "```",
        "code",
        "```",
        "",
        "After the fence",
        "---",
        "",
        "**Bold title**",
        "=",
        "",
      ].join("\n"),
    );
    expect(sections(index)).toEqual([
      { anchor: "overview", depth: 1, startLine: 1 },
      { anchor: "details", depth: 2, startLine: 6 },
      { anchor: "after-the-fence", depth: 2, startLine: 13 },
      { anchor: "bold-title", depth: 1, startLine: 16 },
    ]);
  });

  it("ignores --- and === lines inside a fenced block", async () => {
    const index = await indexPage(
      [
        "# Fenced",
        "",
        "```markdown",
        "Inside title",
        "------------",
        "Another",
        "=======",
        "```",
        "",
      ].join("\n"),
    );
    expect(sections(index)).toEqual([{ anchor: "fenced", depth: 1, startLine: 1 }]);
    expect(document(index).codeBlocks).toEqual([
      { language: "markdown", startLine: 3, endLine: 8 },
    ]);
  });

  it("keeps front matter out of setext detection", async () => {
    const index = await indexPage(
      ["---", "title: Front matter", "---", "---", "", "Body", "====", ""].join("\n"),
    );
    expect(sections(index)).toEqual([{ anchor: "body", depth: 1, startLine: 6 }]);
    expect(document(index).frontmatter).toEqual([{ name: "title", type: "string" }]);

    const underlined = await indexPage(["---", "title: x", "---", "Intro", "---", ""].join("\n"));
    expect(sections(underlined)).toEqual([{ anchor: "intro", depth: 2, startLine: 4 }]);
  });

  it.each([
    ["an ATX heading", "# Title\n---\n", [{ anchor: "title", depth: 1, startLine: 1 }]],
    ["a list item", "- item\n---\n", []],
    ["a block quote", "> quote\n---\n", []],
    ["an HTML comment", "<!-- note -->\n---\n", []],
    ["an HTML block tag", '<p align="center">\n---\n', []],
    ["a lone HTML tag", '<img src="logo.png" alt="Logo">\n---\n', []],
    ["a JSX closing tag that ends component text", "<Note>\nRemember this.\n</Note>\n---\n", []],
    ["an HTML closing tag that ends block text", "<div>\nBlock text\n</div>\n---\n", []],
    ["a deeply indented closing tag", "Intro text\n        </div>\n---\n", []],
    [
      "a JSX member tag with expression attributes",
      '<Tabs.Item value={"a b"} label={x}>\nTab text\n</Tabs.Item>\n===\n',
      [],
    ],
    ["a thematic break", "***\n---\n", []],
    ["an indented code line", "    code\n---\n", []],
    ["a MyST colon fence", ":::{note}\n---\n", []],
    ["a link reference definition", "[ref]: https://example.com\n===\n", []],
  ])("reads --- or === after %s as no setext underline", async (_kind, contents, expected) => {
    expect(sections(await indexPage(contents))).toEqual(expected);
  });

  it("keeps a thematic break after an ATX heading in the body and leaves setext underlines out", async () => {
    const body = async (contents: string) => document(await indexPage(contents)).regions.body;
    expect(await body("# Title\n---\nBody.\n")).not.toBe(await body("# Title\n\nBody.\n"));
    expect(await body("Title\n---\nBody.\n")).toBe(await body("Title\n===\nBody.\n"));
  });

  it("underlines an indented continuation line and a line that starts with inline HTML", async () => {
    const index = await indexPage(
      ["Lazy", "    continuation", "---", "", "<kbd>Ctrl</kbd> shortcuts", "---", ""].join("\n"),
    );
    expect(sections(index)).toEqual([
      { anchor: "continuation", depth: 2, startLine: 2 },
      { anchor: "ctrl-shortcuts", depth: 2, startLine: 5 },
    ]);
  });
});

describe("page anchor stops on a target page", () => {
  it("stops with empty-page-anchor naming the page, both setext lines, and the edit", async () => {
    const error = await refusal(["# Guide", "", "🚀", "---", ""].join("\n"), "docs/guide.md");
    expect(error.code).toBe("empty-page-anchor");
    expect(error.message).toBe(
      "Line 4 of docs/guide.md underlines line 3 as a heading that has no letter or digit to form an anchor. If line 4 is a thematic break, put a blank line before it; otherwise add a letter or digit to the heading text.",
    );

    const envelope = toOperatorErrorEnvelope(error);
    expect(envelope).toMatchObject({
      code: "empty-page-anchor",
      message: error.message,
      nextAction: PAGE_ANCHOR_NEXT_ACTIONS["empty-page-anchor"],
      docsAnchor: LIVE_AGENT_TROUBLESHOOTING,
      failure: { class: "operator-input", layer: "cli", code: "empty-page-anchor" },
    });
    const human = formatOperatorErrorEnvelope(envelope).split("\n");
    expect(human).toContain("code: empty-page-anchor");
    expect(human).toContain("failure class: operator-input (layer cli)");
    expect(human).toContain(`Next action: ${PAGE_ANCHOR_NEXT_ACTIONS["empty-page-anchor"]}`);

    // The edit the message names clears the stop.
    const fixed = await indexPage(
      ["# Guide", "", "🚀", "", "---", ""].join("\n"),
      "docs/guide.md",
      ["docs/guide.md"],
    );
    expect(sections(fixed, "docs/guide.md")).toEqual([{ anchor: "guide", depth: 1, startLine: 1 }]);
  });

  it("stops with empty-page-anchor for an ATX heading and admits an explicit anchor", async () => {
    const error = await refusal("## 🚀\n");
    expect(error.code).toBe("empty-page-anchor");
    expect(error.message).toBe(
      "The heading at line 1 of README.md has no letter or digit to form an anchor. Add a letter or digit to the heading text, or give the heading an explicit {#anchor}.",
    );
    expect(sections(await indexPage("## 🚀 {#launch}\n", "README.md", ["README.md"]))).toEqual([
      { anchor: "launch", depth: 2, startLine: 1 },
    ]);
  });

  it("stops with duplicate-page-anchor naming both explicit anchor lines", async () => {
    const error = await refusal("# First {#shared}\n\n# Second {#shared}\n");
    expect(error.code).toBe("duplicate-page-anchor");
    expect(error.message).toBe(
      "The explicit anchor at line 3 of README.md repeats the anchor defined at line 1. Rename one of them so each anchor on the page is unique.",
    );
    expect(toOperatorErrorEnvelope(error)).toMatchObject({
      code: "duplicate-page-anchor",
      nextAction: PAGE_ANCHOR_NEXT_ACTIONS["duplicate-page-anchor"],
      docsAnchor: LIVE_AGENT_TROUBLESHOOTING,
      failure: { class: "operator-input", layer: "cli", code: "duplicate-page-anchor" },
    });
  });

  it("names the MyST label lines, not the headings they label", async () => {
    const error = await refusal("(shared)=\n# One\n\n(shared)=\n# Two\n");
    expect(error.code).toBe("duplicate-page-anchor");
    expect(error.message).toContain(
      "The MyST label at line 4 of README.md repeats the anchor defined at line 1.",
    );
  });

  it("keeps the catalog next action when the page path contains a remediation keyword", async () => {
    const error = await refusal("# 🚀\n", "docs/configuration/profile-doctor.md");
    const envelope = toOperatorErrorEnvelope(error);
    expect(envelope.message).toContain("docs/configuration/profile-doctor.md");
    expect(envelope.nextAction).toBe(PAGE_ANCHOR_NEXT_ACTIONS["empty-page-anchor"]);
    expect(envelope.docsAnchor).toBe(LIVE_AGENT_TROUBLESHOOTING);
  });

  it("records a page anchor stop inside a run as operator input at the workflow layer", async () => {
    const error = await refusal('<a id="same"></a>\n\nText.\n\n<a id="same"></a>\n');
    expect(error.message).toContain(
      "The HTML id at line 5 of README.md repeats the anchor defined at line 1.",
    );
    expect(classifyThrownFailure(error, "workflow")).toEqual({
      class: "operator-input",
      layer: "workflow",
      code: "duplicate-page-anchor",
    });
  });

  it("keeps each situation catalog next action equal to the error's next action", () => {
    for (const code of ["empty-page-anchor", "duplicate-page-anchor"] as const) {
      expect(DEFAULT_NEXT_ACTIONS[code], code).toBe(PAGE_ANCHOR_NEXT_ACTIONS[code]);
      expect(DEFAULT_DOCS_ANCHORS[code], code).toBe(LIVE_AGENT_TROUBLESHOOTING);
      expect(new ContentIndexError(code, "A page anchor was refused.").nextAction).toBe(
        PAGE_ANCHOR_NEXT_ACTIONS[code],
      );
    }
    expect(
      new ContentIndexError("duplicate-node-identity", "A document identity repeats.").nextAction,
    ).toBeUndefined();
  });
});
