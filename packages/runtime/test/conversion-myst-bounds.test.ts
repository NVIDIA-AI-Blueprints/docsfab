// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { formatLimitObservation } from "../src/config/limits.js";
import {
  MYST_READER_LIMIT_NAMES,
  createMystFileTree,
  createMystMemoryTree,
  readMystSource,
  readMystSubstitutions,
  resolveConversionIr,
  resolveMystReaderLimits,
  type ConversionIrV1,
  type ConversionSource,
} from "../src/conversion/index.js";

const SOURCE: ConversionSource = {
  generator: "sphinx",
  root: "docs",
  repositoryRevision: "0123456789abcdef0123456789abcdef01234567",
  extensionModules: [],
};

function read(files: Record<string, string>, pages: string[] = ["index.md"]): ConversionIrV1 {
  return readMystSource({ source: SOURCE, tree: createMystMemoryTree(files), pages });
}

function refusalOf(action: () => unknown): Error & Record<string, unknown> {
  try {
    action();
  } catch (error) {
    return error as Error & Record<string, unknown>;
  }
  throw new Error("expected a refusal");
}

const temporaryRoots: string[] = [];
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("MyST reader bounds", () => {
  it("resolves its bounds from the limits catalog", () => {
    const limits = resolveMystReaderLimits();
    expect(limits.maxSourceBytes.name).toBe(MYST_READER_LIMIT_NAMES.maxSourceBytes);
    expect(limits.maxNestingDepth.name).toBe("conversion.maxNestingDepth");
    expect(limits.maxNestingDepth.refusal).toBe("conversion-max-nesting-depth-bound");
  });

  it("reads a page at contentIndex.maxSourceBytes and refuses one byte over", () => {
    const bound = resolveMystReaderLimits().maxSourceBytes;
    const fence = "```\n";
    const atBound = `${fence}${"x".repeat(bound.value - 2 * fence.length)}\n${fence.trimEnd()}`;
    expect(new TextEncoder().encode(atBound).byteLength).toBe(bound.value);
    expect(read({ "index.md": atBound }).documents[0]!.children).toHaveLength(1);
    const refusal = refusalOf(() => read({ "index.md": `${atBound}\n` }));
    expect(refusal.code).toBe(bound.refusal);
    expect(refusal.observed).toBe(bound.value + 1);
    expect(refusal.message).toBe(
      `docs/index.md: ${formatLimitObservation(bound, bound.value + 1)}`,
    );
  });

  it("reads block nesting at conversion.maxNestingDepth and refuses one level over", () => {
    const bound = resolveMystReaderLimits().maxNestingDepth;
    const quotes = (depth: number): string => `${"> ".repeat(depth)}deep\n`;
    const ir = read({ "index.md": quotes(bound.value) });
    let depth = 0;
    let node = ir.documents[0]!.children[0];
    while (node?.kind === "blockquote") {
      depth += 1;
      node = node.children[0];
    }
    expect(depth).toBe(bound.value);
    const refusal = refusalOf(() => read({ "index.md": quotes(bound.value + 1) }));
    expect(refusal.code).toBe(bound.refusal);
    expect(refusal.observed).toBe(bound.value + 1);
    expect(refusal.message).toContain("docs/index.md:1: ");
  });

  it("counts nested directive fences and inline containers toward the nesting bound", () => {
    const bound = resolveMystReaderLimits().maxNestingDepth;
    const fences = (depth: number): string => {
      const lines: string[] = [];
      for (let level = 0; level < depth; level += 1)
        lines.push(`${":".repeat(3 + depth - level)}{note}`);
      lines.push("Body.");
      for (let level = depth - 1; level >= 0; level -= 1) lines.push(":".repeat(3 + depth - level));
      return `${lines.join("\n")}\n`;
    };
    expect(read({ "index.md": fences(bound.value) }).documents[0]!.children).toHaveLength(1);
    expect(refusalOf(() => read({ "index.md": fences(bound.value + 1) })).observed).toBe(
      bound.value + 1,
    );
    const emphasized = (quotes: number): string => `${"> ".repeat(quotes)}*deep*\n`;
    expect(read({ "index.md": emphasized(bound.value - 1) }).documents).toHaveLength(1);
    expect(refusalOf(() => read({ "index.md": emphasized(bound.value) })).observed).toBe(
      bound.value + 1,
    );
  });
});

describe("MyST reader include containment on disk", () => {
  function site(): { repository: string; docs: string } {
    const repository = mkdtempSync(join(tmpdir(), "docsfab-myst-"));
    temporaryRoots.push(repository);
    const docs = join(repository, "docs");
    mkdirSync(join(docs, "snippets"), { recursive: true });
    writeFileSync(join(repository, "secret.md"), "Outside the documentation root.\n");
    writeFileSync(join(docs, "snippets", "inside.md"), "Inside.\n");
    return { repository, docs };
  }

  it("reads includes under the root and refuses a symbolic link that leaves it", () => {
    const { repository, docs } = site();
    symlinkSync(join(repository, "secret.md"), join(docs, "snippets", "linked.md"));
    writeFileSync(join(docs, "index.md"), "```{include} snippets/inside.md\n```\n");
    writeFileSync(join(docs, "escape.md"), "```{include} snippets/linked.md\n```\n");
    const tree = createMystFileTree(docs);
    const ir = readMystSource({ source: SOURCE, tree, pages: ["index.md"] });
    expect(ir.documents.map((document) => document.sourcePath)).toEqual([
      "docs/index.md",
      "docs/snippets/inside.md",
    ]);
    const refusal = refusalOf(() => readMystSource({ source: SOURCE, tree, pages: ["escape.md"] }));
    expect(refusal.code).toBe("conversion-include-outside-root");
  });

  it("refuses a lexical include escape before touching the file system", () => {
    const { docs } = site();
    writeFileSync(join(docs, "index.md"), "```{include} ../secret.md\n```\n");
    const refusal = refusalOf(() =>
      readMystSource({ source: SOURCE, tree: createMystFileTree(docs), pages: ["index.md"] }),
    );
    expect(refusal.code).toBe("conversion-include-outside-root");
    expect(refusal.message).toContain("docs/index.md:1");
  });
});

describe("MyST substitutions from conf.py", () => {
  it("reads string literals as values and records other values as expressions", () => {
    const entries = readMystSubstitutions(
      [
        "import os",
        "project = 'Demo'",
        "myst_substitutions = {",
        '    "product": "NeMo",  # the product',
        "    'joined': 'a' \"b\",",
        '    "version": os.environ.get("VERSION", "dev"),',
        '    "escaped": "tab\\there",',
        '    "punctuation": "} # myst_substitutions",',
        "}",
        "",
      ].join("\n"),
      "docs/conf.py",
    );
    expect(entries).toEqual([
      {
        name: "product",
        value: { kind: "literal", text: "NeMo" },
        origin: { kind: "configuration", path: "docs/conf.py", span: { startLine: 4, endLine: 4 } },
      },
      {
        name: "joined",
        value: { kind: "literal", text: "ab" },
        origin: { kind: "configuration", path: "docs/conf.py", span: { startLine: 5, endLine: 5 } },
      },
      {
        name: "version",
        value: { kind: "computed", expression: 'os.environ.get("VERSION", "dev")' },
        origin: { kind: "configuration", path: "docs/conf.py", span: { startLine: 6, endLine: 6 } },
      },
      {
        name: "escaped",
        value: { kind: "literal", text: "tab\there" },
        origin: { kind: "configuration", path: "docs/conf.py", span: { startLine: 7, endLine: 7 } },
      },
      {
        name: "punctuation",
        value: { kind: "literal", text: "} # myst_substitutions" },
        origin: { kind: "configuration", path: "docs/conf.py", span: { startLine: 8, endLine: 8 } },
      },
    ]);
    const ir = readMystSource({
      source: SOURCE,
      tree: createMystMemoryTree({ "index.md": "{{ version }}\n" }),
      pages: ["index.md"],
      substitutions: entries,
    });
    expect(resolveConversionIr(ir).units.map((unit) => unit.id)).toEqual([
      "unit:substitution:version",
    ]);
  });

  it("returns no entries without myst_substitutions and refuses a non-static table", () => {
    expect(readMystSubstitutions("extensions = ['myst_parser']\n", "conf.py")).toEqual([]);
    for (const conf of [
      "myst_substitutions = build_table()\n",
      'myst_substitutions = {"a": "1"}\nmyst_substitutions = {"b": "2"}\n',
      'myst_substitutions = {"a": "1"}\nmyst_substitutions["b"] = "2"\n',
      'myst_substitutions = {"a": "1"}\nmyst_substitutions.update(extra)\n',
      'myst_substitutions = {"a": "old"} | {"a": "new"}\n',
      'myst_substitutions = {"a": "old"}; myst_substitutions["a"] = "new"\n',
      'myst_substitutions = {"a": "old"}\nif enabled:\n    myst_substitutions["a"] = "new"\n',
      "if enabled:\n    myst_substitutions.update(extra)\n",
      "myst_substitutions = {name: '1'}\n",
    ]) {
      const refusal = refusalOf(() => readMystSubstitutions(conf, "docs/conf.py"));
      expect(refusal.code, conf).toBe("conversion-configuration-not-static");
    }
  });

  it("does not pass a partially read configuration table into the page reader", () => {
    const conf = 'myst_substitutions = {"product": "old"} | {"product": "new"}\n';
    const refusal = refusalOf(() => {
      const substitutions = readMystSubstitutions(conf, "docs/conf.py");
      return readMystSource({
        source: SOURCE,
        tree: createMystMemoryTree({ "index.md": "{{ product }}\n" }),
        pages: ["index.md"],
        substitutions,
      });
    });
    expect(refusal.code).toBe("conversion-configuration-not-static");
    expect(refusal.message).toContain("docs/conf.py:1");
  });
});
