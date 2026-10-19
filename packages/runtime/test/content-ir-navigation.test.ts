// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * MkDocs navigation in the content index: only the `nav` tree counts, its
 * entries resolve against `docs_dir`, and an entry the index cannot link is
 * recorded by name instead of stopping indexing.
 */
import { execFile } from "node:child_process";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  buildContentIndex,
  buildContentIndexV2,
  buildScopedContentIndex,
  contentIndexLimitations,
  describeContentIndexLimitation,
} from "../src/content-ir/index.js";
import type { ContentIndexV1, ContentIndexV2, DocumentNode } from "../src/content-ir/index.js";
import { buildContentIndexV3 } from "../src/content-ir/indexer.js";
import { prepareRunPreflight } from "../src/cli/run/preflight.js";
import type { CliRunInvocation } from "../src/cli/run/request.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import { commitFixture, initFixtureRepo } from "./helpers/git.js";
import { temporaryRoots } from "./helpers/temp.js";

const REVISION = "a".repeat(40);
const roots = temporaryRoots();
const execFileAsync = promisify(execFile);
const runtimeRoot = fileURLToPath(new URL("..", import.meta.url));
const indexerModule = fileURLToPath(new URL("../src/content-ir/indexer.ts", import.meta.url));

async function repository(files: Record<string, string>): Promise<string> {
  const root = await roots.create("docsfab-content-ir-navigation-");
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), contents, "utf8");
  }
  return root;
}

async function index(files: Record<string, string>): Promise<ContentIndexV1> {
  return buildContentIndex({
    repositoryPath: await repository(files),
    repositoryRevision: REVISION,
  });
}

/**
 * Each repository's limitations and navigation edge count, read in a
 * subprocess that SIGKILL ends if it hangs, optionally with a smaller heap.
 */
async function limitationsInSubprocess(
  paths: readonly string[],
  options: { readonly maxOldSpaceMegabytes?: number; readonly timeoutMs?: number } = {},
): Promise<Array<{ limitations: unknown[]; navigation: number }>> {
  const script = [
    `import { buildContentIndex, contentIndexLimitations } from ${JSON.stringify(indexerModule)};`,
    "const results = [];",
    "for (const repositoryPath of process.argv.slice(1)) {",
    `  const built = await buildContentIndex({ repositoryPath, repositoryRevision: ${JSON.stringify(REVISION)} });`,
    '  results.push({ limitations: contentIndexLimitations(built), navigation: built.edges.filter((edge) => edge.kind === "navigation").length });',
    "}",
    "process.stdout.write(JSON.stringify(results));",
  ].join("\n");
  const heap = options.maxOldSpaceMegabytes
    ? [`--max-old-space-size=${options.maxOldSpaceMegabytes}`]
    : [];
  const { stdout } = await execFileAsync(
    process.execPath,
    [...heap, "--import", "tsx", "--input-type=module", "-e", script, ...paths],
    {
      cwd: runtimeRoot,
      encoding: "utf8",
      timeout: options.timeoutMs ?? 60_000,
      killSignal: "SIGKILL",
    },
  );
  return JSON.parse(stdout);
}

/** `levels` nested merge keys that each use the level below twice; MkDocs builds it. */
function mergeFanOut(levels: number, under?: string): string {
  const indent = under ? "  " : "";
  const lines = ["site_name: Example", ...(under ? [`${under}:`] : [])];
  lines.push(`${indent}m0: &m0 {k: v, j: w}`);
  for (let level = 1; level <= levels; level += 1) {
    const below = `*m${level - 1}`;
    lines.push(`${indent}m${level}: &m${level} {a: {<<: ${below}}, b: {<<: ${below}}}`);
  }
  return [...lines, "nav:", "  - index.md", "  - guide.md", ""].join("\n");
}

/** Navigation edges as `from -> to` source paths. */
function navigationEdges(built: ContentIndexV1 | ContentIndexV2): string[] {
  const paths = new Map(
    built.nodes
      .filter((node): node is DocumentNode => node.kind === "document")
      .map((node) => [node.id, node.sourcePath]),
  );
  return built.edges
    .filter((edge) => edge.kind === "navigation")
    .map((edge) => `${paths.get(edge.from)} -> ${paths.get(edge.to)}`)
    .sort();
}

const DOCS = {
  "docs/index.md": "# Home\n",
  "docs/guide.md": "# Guide\n",
  "docs/reference/api.md": "# API\n",
};

describe("MkDocs navigation", () => {
  it("resolves nav entries against the default docs directory", async () => {
    const built = await index({
      ...DOCS,
      "mkdocs.yml": [
        "site_name: Example",
        "nav:",
        "  - Home: index.md",
        "  - Guide: guide.md",
        "  - Reference: reference/api.md",
        "",
      ].join("\n"),
    });
    expect(navigationEdges(built)).toEqual([
      "docs/guide.md -> docs/reference/api.md",
      "docs/index.md -> docs/guide.md",
    ]);
    expect(contentIndexLimitations(built)).toEqual([]);
  });

  it("resolves nav entries against a configured docs_dir, through nested sections", async () => {
    const built = await index({
      "site/content/index.md": "# Home\n",
      "site/content/guide/intro.md": "# Intro\n",
      "site/content/guide/deep/more.md": "# More\n",
      "site/content/faq.md": "# FAQ\n",
      "mkdocs.yml": [
        "docs_dir: site/content",
        "nav:",
        "  - index.md",
        "  - User guide:",
        "      - Intro: guide/intro.md",
        "      - Deeper:",
        "          - guide/deep/more.md",
        "  - FAQ: faq.md",
        "",
      ].join("\n"),
    });
    expect(navigationEdges(built)).toEqual([
      "site/content/guide/deep/more.md -> site/content/faq.md",
      "site/content/guide/intro.md -> site/content/guide/deep/more.md",
      "site/content/index.md -> site/content/guide/intro.md",
    ]);
    expect(contentIndexLimitations(built)).toEqual([]);
  });

  it("skips external URL and absolute-path entries without breaking the chain", async () => {
    const built = await index({
      ...DOCS,
      "mkdocs.yml": [
        "nav:",
        "  - index.md",
        "  - Issue tracker: https://example.com/issues.md",
        "  - Site root: /landing.md",
        "  - guide.md",
        "",
      ].join("\n"),
    });
    expect(navigationEdges(built)).toEqual(["docs/index.md -> docs/guide.md"]);
    expect(contentIndexLimitations(built)).toEqual([]);
  });

  it("records a nav entry whose page is missing, naming it, and keeps indexing", async () => {
    const built = await index({
      ...DOCS,
      "mkdocs.yml": [
        "nav:",
        "  - index.md",
        "  - Runbooks: reference/runbooks.md",
        "  - guide.md",
        "",
      ].join("\n"),
    });
    const limitations = contentIndexLimitations(built);
    expect(limitations).toEqual([
      {
        path: "mkdocs.yml",
        reason: "page-not-indexed",
        entry: "reference/runbooks.md",
        resolvedPath: "docs/reference/runbooks.md",
      },
    ]);
    expect(describeContentIndexLimitation(limitations[0]!)).toBe(
      'mkdocs.yml lists "reference/runbooks.md", which resolves to "docs/reference/runbooks.md", a page the content index does not contain; navigation skips it.',
    );
    // The missing entry breaks the chain instead of making its neighbours adjacent.
    expect(navigationEdges(built)).toEqual([]);
    expect(built.nodes.filter((node) => node.kind === "document")).toHaveLength(3);

    // An entry listed twice is named once, and breaks the chain both times.
    const twice = await index({
      ...DOCS,
      "mkdocs.yml": "nav: [index.md, missing.md, guide.md, missing.md, reference/api.md]\n",
    });
    expect(contentIndexLimitations(twice)).toEqual([
      {
        path: "mkdocs.yml",
        reason: "page-not-indexed",
        entry: "missing.md",
        resolvedPath: "docs/missing.md",
      },
    ]);
    expect(navigationEdges(twice)).toEqual([]);
  });

  it("never reads plugin configuration lists as navigation, with or without nav", async () => {
    const plugins = [
      "plugins:",
      "  - search",
      "  - exclude:",
      "      glob:",
      "        - smoketest.md",
      "        - drafts/*.md",
      "  - awesome-nav",
    ];
    const withoutNav = await index({ ...DOCS, "mkdocs.yml": [...plugins, ""].join("\n") });
    expect(navigationEdges(withoutNav)).toEqual([]);
    expect(contentIndexLimitations(withoutNav)).toEqual([]);

    const withNav = await index({
      ...DOCS,
      "mkdocs.yml": [...plugins, "nav:", "  - index.md", "  - guide.md", ""].join("\n"),
    });
    expect(navigationEdges(withNav)).toEqual(["docs/index.md -> docs/guide.md"]);
    expect(contentIndexLimitations(withNav)).toEqual([]);
  });

  it("reads Python tags, environment tags, and repeated keys as MkDocs does", async () => {
    const built = await index({
      ...DOCS,
      "mkdocs.yml": [
        "site_name: First",
        "site_name: Second",
        "markdown_extensions:",
        "  - pymdownx.emoji:",
        "      emoji_index: !!python/name:material.extensions.emoji.twemoji",
        "extra:",
        "  analytics: !ENV [ANALYTICS_KEY, none]",
        "nav:",
        "  - index.md",
        "  - guide.md",
        "",
      ].join("\n"),
    });
    expect(navigationEdges(built)).toEqual(["docs/index.md -> docs/guide.md"]);

    // The last of a repeated nav key wins, as PyYAML keeps it.
    const repeatedNav = await index({
      ...DOCS,
      "mkdocs.yml": "nav: [guide.md, index.md]\nnav: [index.md, guide.md]\n",
    });
    expect(navigationEdges(repeatedNav)).toEqual(["docs/index.md -> docs/guide.md"]);
  });

  it("records unreadable YAML and an entry outside the repository instead of stopping", async () => {
    const unreadable = await index({ ...DOCS, "mkdocs.yml": "nav:\n  - index.md\n   - bad: [\n" });
    expect(contentIndexLimitations(unreadable)).toEqual([
      {
        path: "mkdocs.yml",
        reason: "unreadable-navigation",
        detail: "it is not valid YAML",
      },
    ]);
    expect(navigationEdges(unreadable)).toEqual([]);

    const outside = await index({ ...DOCS, "mkdocs.yml": "nav:\n  - index.md\n  - ../../x.md\n" });
    expect(contentIndexLimitations(outside)).toEqual([
      { path: "mkdocs.yml", reason: "outside-repository", entry: "../../x.md" },
    ]);
    expect(describeContentIndexLimitation(contentIndexLimitations(outside)[0]!)).toBe(
      'mkdocs.yml lists "../../x.md", which resolves outside the repository; navigation skips it.',
    );
  });

  it("resolves beside mkdocs.yml only when the default docs directory does not exist", async () => {
    const legacy = await index({
      "index.md": "# Home\n",
      "guide.md": "# Guide\n",
      "mkdocs.yml": "nav:\n  - Home: index.md\n  - Guide: guide.md\n",
    });
    expect(navigationEdges(legacy)).toEqual(["index.md -> guide.md"]);

    // With a docs/ directory, the default applies even to a name that also exists at the root.
    const standard = await index({
      ...DOCS,
      "README.md": "# Readme\n",
      "mkdocs.yml": "nav:\n  - index.md\n  - README.md\n",
    });
    expect(contentIndexLimitations(standard)).toEqual([
      {
        path: "mkdocs.yml",
        reason: "page-not-indexed",
        entry: "README.md",
        resolvedPath: "docs/README.md",
      },
    ]);
  });

  it("finds the default docs directory whatever pages an index selected", async () => {
    const layout = {
      ...DOCS,
      "README.md": "# Readme\n",
      "mkdocs.yml": "nav: [index.md, guide.md]\n",
    };
    // A focused index on the root README reads none of docs/: the entries
    // are out of scope, not missing pages at the root.
    const focused = await buildScopedContentIndex({
      repositoryPath: await repository(layout),
      repositoryRevision: REVISION,
      includePaths: ["README.md"],
    });
    if (focused.status !== "indexed") throw new Error("The focused index refused an alias.");
    expect(contentIndexLimitations(focused.index)).toEqual([]);
    expect(focused.coverage.outOfScopeNavigationTargets).toBe(2);

    // A symlinked docs/ directory is the default too; navigation resolves through it.
    const linked = await repository({
      "site/docs/index.md": "# Home\n",
      "site/docs/guide.md": "# Guide\n",
      "mkdocs.yml": "nav: [index.md, guide.md]\n",
    });
    await symlink("site/docs", join(linked, "docs"));
    const throughLink = await buildContentIndex({
      repositoryPath: linked,
      repositoryRevision: REVISION,
    });
    expect(navigationEdges(throughLink)).toEqual(["site/docs/index.md -> site/docs/guide.md"]);
    expect(contentIndexLimitations(throughLink)).toEqual([]);
  });

  it("never records a page outside narrowed documentation roots as missing", async () => {
    const narrowed = await buildContentIndex({
      repositoryPath: await repository({
        "docs/user/a.md": "# A\n",
        "docs/user/b.md": "# B\n",
        "docs/user/c.md": "# C\n",
        "docs/admin/x.md": "# X\n",
        "mkdocs.yml": "nav: [user/a.md, user/b.md, admin/x.md, user/c.md]\n",
      }),
      repositoryRevision: REVISION,
      includePaths: ["docs/user"],
    });
    // The unselected page breaks the chain, like any entry the index cannot link.
    expect(navigationEdges(narrowed)).toEqual(["docs/user/a.md -> docs/user/b.md"]);
    expect(contentIndexLimitations(narrowed)).toEqual([]);
  });

  it("records a nav that contains itself through a YAML alias, and never hangs", async () => {
    // A cycle must end the walk, so run it where a hang can be killed.
    const variants = {
      cyclic: "nav: &a [*a]\n",
      growing: "nav: &a [index.md, {Section: *a}]\n",
      merged: "base: &base {nav: &n [index.md, {Section: *n}]}\n<<: *base\n",
    };
    const paths: string[] = [];
    for (const configuration of Object.values(variants)) {
      paths.push(await repository({ ...DOCS, "mkdocs.yml": configuration }));
    }
    const record = {
      path: "mkdocs.yml",
      reason: "unreadable-navigation",
      detail: "its nav contains itself through a YAML alias",
    };
    const results = await limitationsInSubprocess(paths);
    expect(results.map((result) => result.limitations)).toEqual([[record], [record], [record]]);
  }, 120_000);

  it("never resolves aliases outside nav and docs_dir, and never hangs", async () => {
    // Shapes a whole-document conversion expands before it can count them;
    // each builds with mkdocs build --strict.
    const list = (count: number, item: string) => `[${Array(count).fill(item).join(", ")}]`;
    const nav = "nav:\n  - index.md\n  - guide.md\n";
    const emptyFanOut = `site_name: x\nextra:\n  e: &e []\n  t: &t ${list(800, "*e")}\n  u: ${list(800, "*t")}\n${nav}`;
    const padding = `site_name: x\nextra:\n  p: &p ${list(200_000, "x")}\n  q: ${list(99, "*p")}\n${nav}`;
    const mergeUnderExtra = mergeFanOut(20, "extra");
    expect(Buffer.byteLength(emptyFanOut)).toBe(6_477);
    expect(Buffer.byteLength(padding)).toBe(600_462);
    expect(Buffer.byteLength(mergeUnderExtra)).toBe(902);
    const paths = [];
    for (const configuration of [emptyFanOut, padding, mergeUnderExtra, mergeFanOut(24)]) {
      paths.push(await repository({ ...DOCS, "mkdocs.yml": configuration }));
    }
    expect(await limitationsInSubprocess(paths)).toEqual(
      paths.map(() => ({ limitations: [], navigation: 1 })),
    );
  }, 120_000);

  it("records alias expansion inside nav past a budget of the file's size, and never hangs", async () => {
    // Nested aliases to an empty list: about 10^9 visits if expanded.
    const lines = ["site_name: x", "nav:", "  - index.md", "  - &e0 []"];
    for (let level = 1; level <= 9; level += 1) {
      lines.push(
        `  - &e${level} [${Array(10)
          .fill(`*e${level - 1}`)
          .join(", ")}]`,
      );
    }
    const nestedEmpties = [...lines, "  - guide.md", ""].join("\n");
    expect(Buffer.byteLength(nestedEmpties)).toBe(586);
    const mergeInsideNav = mergeFanOut(20, "extra").replace(
      "nav:\n  - index.md",
      "nav:\n  - index.md\n  - {<<: *m20}",
    );
    const pages = Array.from({ length: 1400 }, (_, item) => (item % 2 ? "guide.md" : "index.md"));
    const repeated = `big: &a [${pages.join(", ")}]\nnav: [${Array(99).fill("*a").join(", ")}]\n`;
    const paths = [];
    for (const configuration of [nestedEmpties, mergeInsideNav, repeated]) {
      paths.push(await repository({ ...DOCS, "mkdocs.yml": configuration }));
    }
    const record = {
      path: "mkdocs.yml",
      reason: "unreadable-navigation",
      detail: "it expands too many YAML aliases",
    };
    expect(await limitationsInSubprocess(paths)).toEqual(
      paths.map(() => ({ limitations: [record], navigation: 0 })),
    );
  }, 120_000);

  it("records an alias that repeats a long nav entry past the file's size, in bounded memory", async () => {
    // 40,000 aliases to one 100,000-character entry: about 4 * 10^9 characters if each were read.
    const long = `site_name: x\nbig: &b ${"a".repeat(100_000)}.md\nnav: [index.md, ${Array(40_000).fill("*b").join(", ")}, guide.md]\n`;
    expect(Buffer.byteLength(long)).toBe(260_051);
    const path = await repository({ ...DOCS, "mkdocs.yml": long });
    expect(await limitationsInSubprocess([path], { maxOldSpaceMegabytes: 512 })).toEqual([
      {
        limitations: [
          {
            path: "mkdocs.yml",
            reason: "unreadable-navigation",
            detail: "it expands too many YAML aliases",
          },
        ],
        navigation: 0,
      },
    ]);
  }, 120_000);

  it("parses commas, environment tags, ordered maps, and long merge lists without slowing down or overflowing", async () => {
    const nav = "nav:\n  - index.md\n  - guide.md\n";
    // Each file is twice the size critic round 4 first reported, so formatted
    // errors (55 s for half these commas, 27 s for half these tags, here) cannot
    // finish inside the time limit on any machine, and plain ones (4 s and 2 s) do.
    // Not valid YAML: each error once formatted its whole line.
    const commas = `site_name: x\nextra: [${",".repeat(640_000)}]\n${nav}`;
    // Valid YAML MkDocs builds: each unknown tag once formatted a warning for its whole line.
    const tags = `site_name: x\nextra: [${Array(160_000).fill("!ENV X").join(", ")}]\n${nav}`;
    // Valid YAML MkDocs builds: !!omap once checked each key against every earlier one.
    const orderedMap = `site_name: x\nextra: !!omap\n${Array.from({ length: 200_000 }, (_, key) => `  - k${key}: 1\n`).join("")}${nav}`;
    // Valid YAML MkDocs builds: 150,000 merged maps, more than one call's arguments.
    const mergeList = `site_name: x\n<<: [${Array(150_000).fill("{}").join(",")}]\n${nav}`;
    expect(Buffer.byteLength(commas)).toBe(640_054);
    expect(Buffer.byteLength(tags)).toBe(1_280_052);
    expect(Buffer.byteLength(orderedMap)).toBe(2_888_948);
    expect(Buffer.byteLength(mergeList)).toBe(450_050);
    const unreadable = {
      limitations: [
        { path: "mkdocs.yml", reason: "unreadable-navigation", detail: "it is not valid YAML" },
      ],
      navigation: 0,
    };
    const read = { limitations: [], navigation: 1 };
    // One subprocess each, so each must finish well inside its own time limit.
    const results = [];
    for (const configuration of [commas, tags, orderedMap, mergeList]) {
      const path = await repository({ ...DOCS, "mkdocs.yml": configuration });
      results.push(...(await limitationsInSubprocess([path], { timeoutMs: 30_000 })));
    }
    expect(results).toEqual([unreadable, read, read, read]);
  }, 180_000);

  it("reads nav and docs_dir that a merge key supplies, as MkDocs does", async () => {
    const fromRoot = await index({
      ...DOCS,
      "mkdocs.yml": "base: &base {nav: [index.md, guide.md]}\n<<: *base\n",
    });
    expect(navigationEdges(fromRoot)).toEqual(["docs/index.md -> docs/guide.md"]);
    expect(contentIndexLimitations(fromRoot)).toEqual([]);

    const inEntry = await index({
      ...DOCS,
      "mkdocs.yml": "home: &home {Home: index.md}\nnav:\n  - {<<: *home, Guide: guide.md}\n",
    });
    expect(navigationEdges(inEntry)).toEqual(["docs/index.md -> docs/guide.md"]);

    const shallow = await index({ ...DOCS, "mkdocs.yml": mergeFanOut(2, "extra") });
    expect(navigationEdges(shallow)).toEqual(["docs/index.md -> docs/guide.md"]);
    expect(contentIndexLimitations(shallow)).toEqual([]);

    // A merge list: the first map that has nav supplies it, before any later one.
    const fromList = await index({
      ...DOCS,
      "mkdocs.yml":
        "a: &a {site_name: x}\nb: &b {nav: [guide.md, index.md]}\nc: &c {nav: [index.md, guide.md]}\n<<: [*a, *b, *c]\n",
    });
    expect(navigationEdges(fromList)).toEqual(["docs/guide.md -> docs/index.md"]);
    expect(contentIndexLimitations(fromList)).toEqual([]);

    // docs_dir from the map a merge key names.
    const mergedDocsDir = await index({
      "site/index.md": "# Home\n",
      "site/guide.md": "# Guide\n",
      "mkdocs.yml": "base: &base {docs_dir: site}\n<<: *base\nnav: [index.md, guide.md]\n",
    });
    expect(navigationEdges(mergedDocsDir)).toEqual(["site/index.md -> site/guide.md"]);
    expect(contentIndexLimitations(mergedDocsDir)).toEqual([]);

    // An explicit key wins over the map a merge key names.
    const explicit = await index({
      ...DOCS,
      "mkdocs.yml":
        "base: &base {nav: [guide.md, index.md], docs_dir: elsewhere}\n<<: *base\nnav: [index.md, guide.md]\ndocs_dir: docs\n",
    });
    expect(navigationEdges(explicit)).toEqual(["docs/index.md -> docs/guide.md"]);
    expect(contentIndexLimitations(explicit)).toEqual([]);
  });

  it("reads docs_dir as MkDocs does, and names a missing or outside one once", async () => {
    const pages = { "index.md": "# Home\n", "guide.md": "# Guide\n" };
    const nav = "nav: [index.md, guide.md]\n";
    // A plain `.` is a path, not a YAML 1.1 float.
    for (const value of [".", '"."', "./"]) {
      const built = await index({ ...pages, "mkdocs.yml": `docs_dir: ${value}\n${nav}` });
      expect(navigationEdges(built), value).toEqual(["index.md -> guide.md"]);
      expect(contentIndexLimitations(built), value).toEqual([]);
    }
    // A null docs_dir keeps the default, docs.
    for (const value of ["null", "Null", "NULL", "~"]) {
      const built = await index({ ...DOCS, "mkdocs.yml": `docs_dir: ${value}\n${nav}` });
      expect(navigationEdges(built), value).toEqual(["docs/index.md -> docs/guide.md"]);
      expect(contentIndexLimitations(built), value).toEqual([]);
    }
    const underscore = await index({
      "._/index.md": "# Home\n",
      "._/guide.md": "# Guide\n",
      "mkdocs.yml": `docs_dir: ._\n${nav}`,
    });
    expect(navigationEdges(underscore)).toEqual(["._/index.md -> ._/guide.md"]);

    const expected = {
      missing: "its docs_dir names no directory in the repository",
      outside: "its docs_dir is outside the repository",
      absolute: "its docs_dir is outside the repository",
    };
    const values = { missing: "nowhere", outside: "../elsewhere", absolute: "/srv/docs" };
    for (const [name, value] of Object.entries(values)) {
      const built = await index({ ...DOCS, "mkdocs.yml": `docs_dir: ${value}\n${nav}` });
      expect(contentIndexLimitations(built), name).toEqual([
        {
          path: "mkdocs.yml",
          reason: "unreadable-navigation",
          detail: expected[name as keyof typeof expected],
        },
      ]);
    }
  });

  it("links a nav of 150,000 entries without overflowing the stack, in every index version", async () => {
    const pages = Array.from({ length: 150_000 }, (_, item) =>
      item % 2 ? "guide.md" : "index.md",
    );
    const files = { ...DOCS, "mkdocs.yml": `nav: [${pages.join(", ")}]\n` };
    const expected = ["docs/guide.md -> docs/index.md", "docs/index.md -> docs/guide.md"];
    const source = await repository(files);
    const v1 = await buildContentIndex({ repositoryPath: source, repositoryRevision: REVISION });
    expect(navigationEdges(v1)).toEqual(expected);
    await initFixtureRepo(source, undefined, { branch: "main" });
    await commitFixture(source, "large navigation fixture");
    const workspace = await prepareRepositoryWorkspace(source, "HEAD");
    try {
      expect(navigationEdges(await buildContentIndexV2({ workspace }))).toEqual(expected);
      expect(navigationEdges(await buildContentIndexV3({ workspace }))).toEqual(expected);
    } finally {
      await workspace.dispose();
    }
  }, 120_000);

  it("reads an alias repeated outside its own anchor as MkDocs does", async () => {
    const built = await index({
      ...DOCS,
      "mkdocs.yml": "nav:\n  - Section: &section [index.md, guide.md]\n  - Again: *section\n",
    });
    expect(contentIndexLimitations(built)).toEqual([]);
    expect(navigationEdges(built)).toEqual([
      "docs/guide.md -> docs/index.md",
      "docs/index.md -> docs/guide.md",
    ]);
  });

  it("names alias expansion, exhaustion, an empty docs_dir, and control characters precisely", async () => {
    let laughs = "a: &a [x.md, x.md, x.md, x.md, x.md, x.md, x.md, x.md, x.md, x.md]\n";
    let previous = "a";
    for (const name of "bcdefghij") {
      laughs += `${name}: &${name} [${Array(10).fill(`*${previous}`).join(", ")}]\n`;
      previous = name;
    }
    const expanded = await index({ ...DOCS, "mkdocs.yml": `${laughs}nav: *${previous}\n` });
    expect(contentIndexLimitations(expanded)).toEqual([
      {
        path: "mkdocs.yml",
        reason: "unreadable-navigation",
        detail: "it expands too many YAML aliases",
      },
    ]);
    const deep = await index({
      ...DOCS,
      "mkdocs.yml": `nav: ${"[".repeat(5000)}x.md${"]".repeat(5000)}\n`,
    });
    expect(contentIndexLimitations(deep)[0]?.detail).toBe(
      "it is too large or too deeply nested to read",
    );

    const undefinedAlias = await index({ ...DOCS, "mkdocs.yml": "nav: [index.md, *nope]\n" });
    expect(contentIndexLimitations(undefinedAlias)[0]?.detail).toBe("it is not valid YAML");

    const empty = await index({ ...DOCS, "mkdocs.yml": "docs_dir:\nnav: [index.md, guide.md]\n" });
    expect(navigationEdges(empty)).toEqual(["docs/index.md -> docs/guide.md"]);
    expect(contentIndexLimitations(empty)).toEqual([]);

    // A directory whose name holds a control character is one no index path
    // can hold (#1941): the walk leaves it out, with its pages and its
    // navigation, and names it escaped.
    const control = await index({
      "x\u001b[31mRED/docs/a.md": "# A\n",
      "x\u001b[31mRED/mkdocs.yml": "nav: [a.md, missing.md]\n",
    });
    expect(control.nodes).toEqual([]);
    const notice = describeContentIndexLimitation(contentIndexLimitations(control)[0]!);
    expect(notice).not.toContain("\u001b");
    expect(notice).toBe(
      `"x\\u001b[31mRED" is a directory the content index leaves out, with every page under it: its name holds a control character, which a content index path cannot hold. Rename it to index its pages.`,
    );
    // A control character a navigation entry spells is named escaped too.
    const entry = await index({ ...DOCS, "mkdocs.yml": 'nav: [index.md, "x\\e[31mRED.md"]\n' });
    const entryNotice = describeContentIndexLimitation(contentIndexLimitations(entry)[0]!);
    expect(entryNotice).not.toContain("\u001b");
    expect(entryNotice).toBe(
      `mkdocs.yml lists "x\\u001b[31mRED.md", which resolves to "docs/x\\u001b[31mRED.md", a page the content index does not contain; navigation skips it.`,
    );
  });

  it("resolves a mkdocs.yml inside docs/ against its own docs_dir default, docs/docs", async () => {
    const built = await index({
      "docs/mkdocs.yml": "site_name: Retriever\nnav:\n  - index.md\n  - API: api/ref.md\n",
      "docs/docs/index.md": "# Home\n",
      "docs/docs/api/ref.md": "# Reference\n",
    });
    expect(navigationEdges(built)).toEqual(["docs/docs/index.md -> docs/docs/api/ref.md"]);
    expect(contentIndexLimitations(built)).toEqual([]);
  });

  it("records a build-generated nav page that is not in the repository", async () => {
    const built = await index({
      ...DOCS,
      "mkdocs.yml": "nav:\n  - index.md\n  - Notebooks: notebooks/README.md\n  - guide.md\n",
    });
    expect(contentIndexLimitations(built)).toEqual([
      {
        path: "mkdocs.yml",
        reason: "page-not-indexed",
        entry: "notebooks/README.md",
        resolvedPath: "docs/notebooks/README.md",
      },
    ]);
  });

  it("keeps root: and file: entries for a Jupyter Book table of contents and ignores other keys", async () => {
    const built = await index({
      "intro.md": "# Intro\n",
      "guide/a.md": "# A\n",
      "guide/b.md": "# B\n",
      "_toc.yml": [
        "root: intro",
        "chapters:",
        "  - file: guide/a",
        "  - glob: guide/*.md",
        "  - url: https://example.com/page.md",
        "  - file: guide/b",
        "",
      ].join("\n"),
    });
    expect(navigationEdges(built)).toEqual(["guide/a.md -> guide/b.md", "intro.md -> guide/a.md"]);
    expect(contentIndexLimitations(built)).toEqual([]);
  });
});

describe("symlinked MkDocs nav pages", () => {
  it("admits an in-repository symlink as an alias that navigation resolves through", async () => {
    const root = await repository({ ...DOCS, "GOVERNANCE.md": "# Governance\n" });
    await symlink("../GOVERNANCE.md", join(root, "docs", "governance.md"));
    await writeFile(
      join(root, "mkdocs.yml"),
      "nav:\n  - index.md\n  - governance.md\n  - guide.md\n",
      "utf8",
    );
    const built = await buildContentIndex({ repositoryPath: root, repositoryRevision: REVISION });
    expect(navigationEdges(built)).toEqual([
      "GOVERNANCE.md -> docs/guide.md",
      "docs/index.md -> GOVERNANCE.md",
    ]);
    expect(contentIndexLimitations(built)).toEqual([]);
    // The alias is never read as a page of its own.
    expect(
      built.nodes.filter(
        (node) => node.kind === "document" && node.sourcePath === "docs/governance.md",
      ),
    ).toEqual([]);
  });

  it("admits a root symlink no task needs, such as CLAUDE.md to AGENTS.md", async () => {
    const root = await repository({ "AGENTS.md": "# Agents\n", "docs/x.md": "# X\n" });
    await symlink("AGENTS.md", join(root, "CLAUDE.md"));
    for (const includePaths of [undefined, ["docs"]]) {
      const built = await buildContentIndex({
        repositoryPath: root,
        repositoryRevision: REVISION,
        ...(includePaths ? { includePaths } : {}),
      });
      expect(contentIndexLimitations(built)).toEqual([]);
    }
  });

  it("resolves navigation through an in-repository directory symlink", async () => {
    const root = await repository({
      "docs/index.md": "# Home\n",
      "docs/v2/index.md": "# V2\n",
      "mkdocs.yml": "nav:\n  - index.md\n  - latest/index.md\n",
    });
    await symlink("v2", join(root, "docs", "latest"));
    const built = await buildContentIndex({ repositoryPath: root, repositoryRevision: REVISION });
    expect(navigationEdges(built)).toEqual(["docs/index.md -> docs/v2/index.md"]);
  });

  it("records a symlink that leads outside the repository or nowhere instead of stopping", async () => {
    const outer = await roots.create("docsfab-content-ir-escape-");
    await writeFile(join(outer, "outside.md"), "# Outside\n", "utf8");
    const root = join(outer, "repository");
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "index.md"), "# Home\n", "utf8");
    await symlink("../../outside.md", join(root, "docs", "outside.md"));
    await symlink("missing.md", join(root, "docs", "dangling.md"));
    const built = await buildContentIndex({ repositoryPath: root, repositoryRevision: REVISION });
    const limitations = contentIndexLimitations(built);
    expect(limitations).toEqual([
      { path: "docs/dangling.md", reason: "symlink-outside-repository" },
      { path: "docs/outside.md", reason: "symlink-outside-repository" },
    ]);
    expect(describeContentIndexLimitation(limitations[1]!)).toBe(
      '"docs/outside.md" is a symlink that leads outside the repository or nowhere; the content index skips it and never follows it.',
    );
    expect(built.nodes.filter((node) => node.kind === "document")).toHaveLength(1);
  });

  it("still refuses a symlink the selected documentation root runs through", async () => {
    const root = await repository({ "site/docs/index.md": "# Home\n" });
    await symlink("site/docs", join(root, "docs"));
    await expect(
      buildContentIndex({
        repositoryPath: root,
        repositoryRevision: REVISION,
        includePaths: ["docs"],
      }),
    ).rejects.toMatchObject({
      code: "unsafe-path",
      message: "Content index rejects symlink: docs.",
    });
  });

  it("records a symlinked nav page as missing in the tracked export a run indexes, never following it", async () => {
    const source = await repository({ ...DOCS, "GOVERNANCE.md": "# Governance\n" });
    await symlink("../GOVERNANCE.md", join(source, "docs", "governance.md"));
    await writeFile(
      join(source, "mkdocs.yml"),
      "nav:\n  - index.md\n  - Governance: governance.md\n  - guide.md\n",
      "utf8",
    );
    await initFixtureRepo(source, undefined, { branch: "main" });
    await commitFixture(source, "navigation fixture");
    const workspace = await prepareRepositoryWorkspace(source, "HEAD");
    try {
      const expected = [
        {
          path: "mkdocs.yml",
          reason: "page-not-indexed",
          entry: "governance.md",
          resolvedPath: "docs/governance.md",
        },
      ];
      const v1 = await buildContentIndex({
        repositoryPath: workspace.path,
        repositoryRevision: workspace.revision,
      });
      expect(contentIndexLimitations(v1)).toEqual(expected);
      expect(navigationEdges(v1)).toEqual([]);
      const v2 = await buildContentIndexV2({ workspace });
      expect(contentIndexLimitations(v2)).toEqual(expected);
    } finally {
      await workspace.dispose();
    }
  });
});

describe("a symlinked docs directory under narrowed documentation roots", () => {
  it("judges an entry by the page the alias stands for, so a missing one is still named", async () => {
    const root = await repository({
      "site/docs/index.md": "# Home\n",
      "site/docs/guide.md": "# Guide\n",
      "mkdocs.yml": "nav: [index.md, guide.md, missing.md]\n",
    });
    await symlink("site/docs", join(root, "docs"));
    const built = await buildContentIndex({
      repositoryPath: root,
      repositoryRevision: REVISION,
      includePaths: ["site/docs"],
    });
    expect(navigationEdges(built)).toEqual(["site/docs/index.md -> site/docs/guide.md"]);
    expect(contentIndexLimitations(built)).toEqual([
      {
        path: "mkdocs.yml",
        reason: "page-not-indexed",
        entry: "missing.md",
        resolvedPath: "docs/missing.md",
      },
    ]);
  });
});

describe("a tracked docs symlink in an export or a workspace index", () => {
  it("stays the default docs directory, and run preflight and postflight agree on it", async () => {
    const source = await repository({
      "index.md": "# Root home\n",
      "guide.md": "# Root guide\n",
      "site/docs/index.md": "# Home\n",
      "site/docs/guide.md": "# Guide\n",
      "mkdocs.yml": "nav: [index.md, guide.md]\n",
    });
    await symlink("site/docs", join(source, "docs"));
    await initFixtureRepo(source, undefined, { branch: "main" });
    await commitFixture(source, "symlinked docs fixture");
    const workspace = await prepareRepositoryWorkspace(source, "HEAD");
    try {
      // The export and the tracked files leave the symlinked pages out, so the
      // entries are missing under docs/, never root pages of the same name.
      const expected = ["index.md", "guide.md"].map((entry) => ({
        path: "mkdocs.yml",
        reason: "page-not-indexed",
        entry,
        resolvedPath: `docs/${entry}`,
      }));
      const v2 = await buildContentIndexV2({ workspace });
      expect(contentIndexLimitations(v2)).toEqual(expected);
      expect(navigationEdges(v2)).toEqual([]);

      const errors: string[] = [];
      const invocation = {
        request: { workflow: "update-documentation" },
        config: {},
        output: { error: (line: string) => errors.push(line) },
      } as unknown as CliRunInvocation;
      const preflight = await prepareRunPreflight(invocation, workspace);
      expect(errors).toEqual(
        expected.map(
          (limitation) =>
            `Content index notice: mkdocs.yml lists "${limitation.entry}", which resolves to "${limitation.resolvedPath}", a page the content index does not contain; navigation skips it.`,
        ),
      );
      if (!("impactPostflight" in preflight) || !preflight.impactPostflight) {
        throw new Error("A write workflow has an impact postflight.");
      }
      // An unchanged workspace indexes the same way after the run.
      expect(
        await preflight.impactPostflight.postflight({
          runId: "symlinked-docs",
          workflow: "update-documentation",
          repository: {
            sourcePath: source,
            requestedRevision: "HEAD",
            revision: workspace.revision,
          },
          workspacePath: workspace.path,
          changedFiles: [],
        }),
      ).toEqual({ schemaVersion: 1, status: "no-change" });
    } finally {
      await workspace.dispose();
    }
  });
});

describe("docsfab run content index notices", () => {
  it("prints one notice per navigation entry the index could not link and keeps preflight going", async () => {
    const source = await repository({
      ...DOCS,
      "mkdocs.yml": "nav:\n  - index.md\n  - reference/runbooks.md\n  - guide.md\n",
    });
    await initFixtureRepo(source, undefined, { branch: "main" });
    await commitFixture(source, "navigation notice fixture");
    const workspace = await prepareRepositoryWorkspace(source, "HEAD");
    const errors: string[] = [];
    try {
      const invocation = {
        request: { workflow: "update-documentation" },
        config: {},
        output: { error: (line: string) => errors.push(line) },
      } as unknown as CliRunInvocation;
      const preflight = await prepareRunPreflight(invocation, workspace);
      expect("contentIndex" in preflight && preflight.contentIndex).toBeTruthy();
      expect(errors).toEqual([
        'Content index notice: mkdocs.yml lists "reference/runbooks.md", which resolves to "docs/reference/runbooks.md", a page the content index does not contain; navigation skips it.',
      ]);
    } finally {
      await workspace.dispose();
    }
  });
});
