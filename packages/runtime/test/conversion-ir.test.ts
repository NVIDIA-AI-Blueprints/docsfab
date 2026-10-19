// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  CONSTRUCT_RULE_REGISTRY,
  CONSTRUCT_RULE_REGISTRY_VERSION,
  CONVERSION_IR_SCHEMA_VERSION,
  NORMALIZED_DIRECTIVE_NODE_KINDS,
  constructRuleRegistryDigest,
  resolveConversionIr,
  type ConstructKey,
  type ConversionBlock,
  type ConversionDocument,
  type ConversionInline,
  type ConversionIrV1,
  type SourceSpan,
} from "../src/conversion/index.js";

let line = 0;
function at(): SourceSpan {
  line += 1;
  return { startLine: line, endLine: line };
}

const text = (id: string, value: string): ConversionInline => ({
  id,
  kind: "text",
  value,
  span: at(),
});

function irWith(
  documents: ConversionDocument[],
  extra: Partial<ConversionIrV1> = {},
): ConversionIrV1 {
  return {
    schemaVersion: CONVERSION_IR_SCHEMA_VERSION,
    source: {
      generator: "sphinx",
      root: "docs",
      repositoryRevision: "0123456789abcdef0123456789abcdef01234567",
      extensionModules: ["myst_parser", "sphinx_design", "nemo_ext.version"],
    },
    documents,
    navigation: {
      entries: [
        {
          kind: "page",
          documentId: "doc-guide",
          title: { text: "Guide", origin: "toctree-entry" },
          hidden: false,
        },
      ],
    },
    labels: [{ label: "install", documentId: "doc-guide", anchor: "install", span: at() }],
    routes: [{ documentId: "doc-guide", sourceRoute: "/guide" }],
    assets: [{ id: "asset-arch", sourcePath: "docs/_static/arch.png", role: "image" }],
    substitutions: [],
    dropLedger: [],
    ...extra,
  };
}

function document(id: string, children: ConversionBlock[]): ConversionDocument {
  return { id, sourcePath: `docs/${id}.md`, format: "myst", frontmatter: {}, children };
}

/** A realistic MyST page: every seeded family appears at least once, nested the way readers emit it. */
function guideDocument(): ConversionDocument {
  return document("doc-guide", [
    { id: "h1", kind: "heading", depth: 1, children: [text("h1-t", "Guide")], span: at() },
    { id: "label-install", kind: "target", label: "install", span: at() },
    {
      id: "p1",
      kind: "paragraph",
      span: at(),
      children: [
        text("p1-t", "Run "),
        { id: "r-cmd", kind: "role", name: "command", content: "nemo run", span: at() },
        text("p1-t2", " on version "),
        { id: "r-ver", kind: "role", name: "nemo-version", content: "current", span: at() },
        { id: "sub-1", kind: "substitutionReference", name: "product", span: at() },
        {
          id: "r-ref",
          kind: "role",
          name: "ref",
          content: "install",
          target: "install",
          span: at(),
        },
        { id: "r-icon", kind: "role", name: "octicon", content: "rocket;1em", span: at() },
        { id: "r-badge", kind: "role", name: "bdg-success", content: "GA", span: at() },
      ],
    },
    {
      id: "note-1",
      kind: "directive",
      name: "note",
      options: [],
      span: at(),
      body: {
        kind: "blocks",
        children: [
          {
            id: "note-1-p",
            kind: "paragraph",
            span: at(),
            children: [
              {
                id: "note-1-em",
                kind: "emphasis",
                span: at(),
                children: [text("note-1-t", "Heads up")],
              },
            ],
          },
        ],
      },
    },
    {
      id: "code-1",
      kind: "codeBlock",
      language: "python",
      value: "print('hi')\n",
      span: at(),
      options: {
        caption: "hello.py",
        emphasizeLines: [{ start: 1, end: 1 }],
        other: [],
      },
    },
    {
      id: "inc-local",
      kind: "include",
      mode: "literal",
      target: { kind: "local", path: "examples/train.py" },
      lines: [{ start: 3, end: 9 }],
      pyobject: "Trainer.fit",
      other: [],
      span: at(),
    },
    {
      id: "inc-remote",
      kind: "include",
      mode: "literal",
      target: { kind: "remote", url: "https://example.com/train.py" },
      other: [],
      span: at(),
    },
    {
      id: "fig-1",
      kind: "figure",
      span: at(),
      image: {
        id: "fig-1-img",
        kind: "image",
        assetId: "asset-arch",
        source: "_static/arch.png",
        options: { alt: "Architecture", other: [] },
        span: at(),
      },
      caption: [text("fig-1-cap", "Architecture")],
      legend: [],
    },
    {
      id: "tabs-1",
      kind: "directive",
      name: "tab-set",
      options: [],
      span: at(),
      body: {
        kind: "blocks",
        children: [
          {
            id: "tab-1",
            kind: "directive",
            name: "tab-item",
            argument: "Linux",
            options: [{ name: "sync", value: "linux" }],
            span: at(),
            body: {
              kind: "blocks",
              children: [
                {
                  id: "tab-1-p",
                  kind: "paragraph",
                  children: [text("tab-1-t", "apt")],
                  span: at(),
                },
              ],
            },
          },
        ],
      },
    },
    {
      id: "only-1",
      kind: "directive",
      name: "only",
      argument: "html",
      options: [],
      span: at(),
      body: {
        kind: "blocks",
        children: [
          {
            id: "only-1-p",
            kind: "paragraph",
            children: [text("only-1-t", "web only")],
            span: at(),
          },
        ],
      },
    },
    {
      id: "todo-1",
      kind: "directive",
      name: "todo",
      options: [],
      span: at(),
      body: {
        kind: "blocks",
        children: [
          { id: "todo-1-p", kind: "paragraph", children: [text("todo-1-t", "fix me")], span: at() },
        ],
      },
    },
    {
      id: "toc-1",
      kind: "directive",
      name: "toctree",
      options: [{ name: "hidden" }],
      body: { kind: "text", value: "install\nusage" },
      span: at(),
    },
    {
      id: "gallery-1",
      kind: "directive",
      name: "nemo-gallery",
      argument: "models",
      options: [{ name: "columns", value: "3" }],
      body: { kind: "none" },
      span: at(),
    },
    {
      id: "api-1",
      kind: "directive",
      name: "automodule",
      argument: "nemo.core",
      options: [],
      body: { kind: "none" },
      span: at(),
    },
    {
      id: "csv-1",
      kind: "directive",
      name: "csv-table",
      options: [{ name: "file", value: "data/models.csv" }],
      body: { kind: "none" },
      span: at(),
    },
  ]);
}

const INLINE_KINDS = new Set([
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

/** The smallest valid node of each typed kind. */
function minimalTypedNode(
  kind: string,
  id: string,
  span: SourceSpan,
): ConversionBlock | ConversionInline {
  const base = { id, span };
  switch (kind) {
    case "heading":
      return { ...base, kind, depth: 2, children: [] };
    case "paragraph":
    case "listItem":
    case "blockquote":
    case "emphasis":
    case "strong":
      return { ...base, kind, children: [] };
    case "list":
      return { ...base, kind, ordered: false, items: [] };
    case "thematicBreak":
    case "lineBreak":
      return { ...base, kind };
    case "codeBlock":
      return { ...base, kind, value: "x", options: { other: [] } };
    case "table":
      return { ...base, kind, headerRows: [], bodyRows: [] };
    case "definitionList":
      return { ...base, kind, items: [] };
    case "fieldList":
      return { ...base, kind, fields: [] };
    case "lineBlock":
      return { ...base, kind, lines: [] };
    case "footnoteDefinition":
      return { ...base, kind, label: "1", children: [] };
    case "target":
      return { ...base, kind, label: "x" };
    case "comment":
    case "html":
    case "math":
    case "text":
    case "inlineCode":
    case "inlineHtml":
    case "inlineMath":
      return { ...base, kind, value: "x" };
    case "image":
      return { ...base, kind, source: "x.png", options: { other: [] } };
    case "figure":
      return {
        ...base,
        kind,
        image: { id: `${id}:image`, kind: "image", source: "x.png", options: { other: [] }, span },
        caption: [],
        legend: [],
      };
    case "link":
      return { ...base, kind, url: "https://example.com", children: [] };
    case "inlineImage":
      return { ...base, kind, source: "x.png" };
    case "footnoteReference":
      return { ...base, kind, label: "1" };
    case "substitutionReference":
      return { ...base, kind, name: "x" };
    default:
      throw new Error(`no minimal node for ${kind}`);
  }
}

describe("conversion IR resolution", () => {
  it("resolves a hand-built page to the expected disposition per node", () => {
    const resolution = resolveConversionIr(irWith([guideDocument()]));
    const byNode = new Map(resolution.nodes.map((node) => [node.nodeId, node]));
    const expected: Record<string, [ConstructKey, string, string]> = {
      h1: ["node:heading", "node:heading", "convert"],
      "label-install": ["node:target", "node:target", "convert"],
      "r-cmd": ["role:command", "role:command", "convert"],
      "r-ver": ["role:nemo-version", "role:*", "judge"],
      "sub-1": ["node:substitutionReference", "node:substitutionReference", "convert"],
      "r-ref": ["role:ref", "role:ref", "convert"],
      "r-icon": ["role:octicon", "role:octicon", "drop-with-notice"],
      "r-badge": ["role:bdg-success", "role:bdg-success", "convert"],
      "note-1": ["directive:note", "directive:note", "convert"],
      "note-1-em": ["node:emphasis", "node:emphasis", "convert"],
      "code-1": ["node:codeBlock", "node:codeBlock", "convert"],
      "inc-local": ["include:literal", "include:literal", "convert"],
      "inc-remote": ["include:remote", "include:remote", "judge"],
      "fig-1": ["node:figure", "node:figure", "convert"],
      "fig-1-img": ["node:image", "node:image", "convert"],
      "fig-1-cap": ["node:text", "node:text", "convert"],
      "tabs-1": ["directive:tab-set", "directive:tab-set", "convert"],
      "tab-1": ["directive:tab-item", "directive:tab-item", "convert"],
      "only-1": ["directive:only", "directive:only", "judge"],
      "only-1-p": ["node:paragraph", "node:paragraph", "convert"],
      "todo-1": ["directive:todo", "directive:todo", "drop-with-notice"],
      "toc-1": ["directive:toctree", "directive:toctree", "drop-with-notice"],
      "gallery-1": ["directive:nemo-gallery", "directive:*", "judge"],
      "api-1": ["directive:automodule", "directive:automodule", "refuse"],
      "csv-1": ["directive:csv-table", "directive:csv-table", "convert"],
    };
    for (const [nodeId, [construct, key, disposition]] of Object.entries(expected)) {
      const resolved = byNode.get(nodeId);
      expect(resolved?.construct, nodeId).toBe(construct);
      expect(resolved?.rule.key, nodeId).toBe(key);
      expect(resolved?.rule.disposition.disposition, nodeId).toBe(disposition);
    }
    expect(byNode.get("code-1")?.rule.disposition).toMatchObject({
      convert: {
        target: "code-block",
        keep: expect.arrayContaining(["caption", "emphasize-lines"]),
      },
    });
    expect(byNode.get("inc-local")?.rule.disposition).toMatchObject({
      convert: { honor: expect.arrayContaining(["lines", "pyobject"]) },
    });
    // A dropped subtree is not resolved node by node.
    expect(byNode.has("todo-1-p")).toBe(false);
    expect(byNode.has("todo-1-t")).toBe(false);
    expect(new Set(resolution.nodes.map((node) => node.nodeId)).size).toBe(resolution.nodes.length);
    expect(resolution.registryVersion).toBe(CONSTRUCT_RULE_REGISTRY_VERSION);
    expect(resolution.registryDigest).toBe(constructRuleRegistryDigest());
  });

  it("records every drop-with-notice node in the drop ledger with its reason", () => {
    const readerDrop = {
      nodeId: "reader-comment",
      documentId: "doc-guide",
      sourcePath: "docs/doc-guide.md",
      construct: "node:comment" as const,
      reason: { code: "editorial-only" as const, text: "Reader removed an orphan marker." },
      span: { startLine: 1, endLine: 1 },
    };
    const resolution = resolveConversionIr(irWith([guideDocument()], { dropLedger: [readerDrop] }));
    const dropped = resolution.nodes
      .filter((node) => node.rule.disposition.disposition === "drop-with-notice")
      .map((node) => node.nodeId);
    expect(dropped).toEqual(["r-icon", "todo-1", "toc-1"]);
    expect(resolution.dropLedger).toEqual([
      readerDrop,
      expect.objectContaining({
        nodeId: "r-icon",
        construct: "role:octicon",
        sourcePath: "docs/doc-guide.md",
        reason: { code: "decorative", text: expect.any(String) },
      }),
      expect.objectContaining({
        nodeId: "todo-1",
        construct: "directive:todo",
        reason: { code: "editorial-only", text: expect.any(String) },
      }),
      expect.objectContaining({
        nodeId: "toc-1",
        construct: "directive:toctree",
        reason: { code: "navigation-owned", text: expect.any(String) },
      }),
    ]);
    for (const entry of resolution.dropLedger) expect(entry.reason.text.length).toBeGreaterThan(0);
  });

  it("enumerates ambiguity units for judged nodes and lists refused nodes", () => {
    const resolution = resolveConversionIr(
      irWith([guideDocument()], {
        substitutions: [
          {
            name: "product",
            value: { kind: "literal", text: "NeMo" },
            origin: {
              kind: "configuration",
              path: "docs/conf.py",
              span: { startLine: 4, endLine: 4 },
            },
          },
          {
            name: "release",
            value: { kind: "computed", expression: "nemo.__version__" },
            origin: {
              kind: "configuration",
              path: "docs/conf.py",
              span: { startLine: 9, endLine: 9 },
            },
          },
        ],
      }),
    );
    expect(resolution.units.map((unit) => [unit.id, unit.kind])).toEqual([
      ["unit:node:r-ver", "custom-construct"],
      ["unit:node:inc-remote", "remote-include"],
      ["unit:node:only-1", "conditional-content"],
      ["unit:node:gallery-1", "custom-construct"],
      ["unit:substitution:release", "non-literal-substitution"],
    ]);
    expect(resolution.units.find((unit) => unit.id === "unit:node:gallery-1")).toEqual({
      schemaVersion: 1,
      id: "unit:node:gallery-1",
      kind: "custom-construct",
      construct: "directive:nemo-gallery",
      nodeId: "gallery-1",
      name: "nemo-gallery",
      argument: "models",
      options: [{ name: "columns", value: "3" }],
      extensionModules: ["myst_parser", "sphinx_design", "nemo_ext.version"],
      excerpt: {
        documentId: "doc-guide",
        sourcePath: "docs/doc-guide.md",
        span: expect.objectContaining({ startLine: expect.any(Number) }),
      },
    });
    expect(resolution.units.find((unit) => unit.id === "unit:node:inc-remote")).toMatchObject({
      url: "https://example.com/train.py",
    });
    expect(resolution.units.find((unit) => unit.id === "unit:node:only-1")).toMatchObject({
      condition: "html",
    });
    expect(resolution.units.find((unit) => unit.id === "unit:substitution:release")).toMatchObject({
      expression: "nemo.__version__",
      excerpt: { sourcePath: "docs/conf.py", span: { startLine: 9, endLine: 9 } },
    });
    expect(resolution.refusals).toEqual([
      expect.objectContaining({
        nodeId: "api-1",
        construct: "directive:automodule",
        reason: "api-reference-generation",
      }),
    ]);
  });

  it("binds plan-level rules in place of judged units and refusals", () => {
    const resolution = resolveConversionIr(
      irWith([guideDocument()], {
        substitutions: [
          {
            name: "release",
            value: { kind: "computed", expression: "nemo.__version__" },
            origin: {
              kind: "configuration",
              path: "docs/conf.py",
              span: { startLine: 9, endLine: 9 },
            },
          },
        ],
      }),
      {
        overrides: [
          {
            kind: "construct",
            construct: "role:nemo-version",
            override: { rule: "keep-literal", text: "26.10" },
            provenance: { source: "judged-answer", unitId: "unit:node:r-ver" },
          },
          {
            kind: "construct",
            construct: "directive:automodule",
            override: { rule: "drop", reason: "The API reference is published separately." },
            provenance: { source: "operator" },
          },
          {
            kind: "substitution",
            name: "release",
            literal: "26.10",
            provenance: { source: "operator" },
          },
        ],
      },
    );
    const version = resolution.nodes.find((node) => node.nodeId === "r-ver");
    expect(version?.rule).toMatchObject({
      key: "role:nemo-version",
      source: "plan-rule",
      disposition: { disposition: "convert", convert: { target: "literal-text", text: "26.10" } },
    });
    expect(resolution.units.map((unit) => unit.id)).toEqual([
      "unit:node:inc-remote",
      "unit:node:only-1",
      "unit:node:gallery-1",
    ]);
    expect(resolution.refusals).toEqual([]);
    expect(resolution.dropLedger.find((entry) => entry.nodeId === "api-1")?.reason).toEqual({
      code: "operator-rule",
      text: "The API reference is published separately.",
    });
    expect(resolution.inventory.find((entry) => entry.construct === "role:nemo-version")).toEqual({
      construct: "role:nemo-version",
      disposition: "convert",
      source: "plan-rule",
      count: 1,
    });
  });

  it("covers every seeded construct with one node and counts it in the inventory", () => {
    const blocks: ConversionBlock[] = [];
    const inlines: ConversionInline[] = [];
    const seeded = CONSTRUCT_RULE_REGISTRY.rules
      .map((rule) => rule.construct)
      .filter((construct) => !construct.endsWith(":*"));
    for (const construct of seeded) {
      const id = `seed:${construct}`;
      const [family, ...rest] = construct.split(":");
      const name = rest.join(":");
      const span = at();
      if (family === "directive") {
        blocks.push({ id, kind: "directive", name, options: [], body: { kind: "none" }, span });
      } else if (family === "role") {
        inlines.push({ id, kind: "role", name, content: "x", span });
      } else if (family === "include") {
        blocks.push({
          id,
          kind: "include",
          mode: name === "markup" ? "markup" : "literal",
          target:
            name === "remote"
              ? { kind: "remote", url: "https://example.com/x" }
              : { kind: "local", path: "x" },
          other: [],
          span,
        });
      } else {
        const node = minimalTypedNode(name, id, span);
        if (INLINE_KINDS.has(name)) inlines.push(node as ConversionInline);
        else blocks.push(node as ConversionBlock);
      }
    }
    blocks.push({ id: "seed:inlines", kind: "paragraph", children: inlines, span: at() });

    const resolution = resolveConversionIr(irWith([document("doc-seed", blocks)]));
    const byNode = new Map(resolution.nodes.map((node) => [node.nodeId, node]));
    for (const construct of seeded) {
      const resolved = byNode.get(`seed:${construct}`);
      expect(resolved?.construct, construct).toBe(construct);
      expect(resolved?.rule.key, construct).toBe(construct);
      expect(resolved?.rule.source).toBe("registry");
      const registered = CONSTRUCT_RULE_REGISTRY.rules.find((rule) => rule.construct === construct);
      expect(resolved?.rule.disposition, construct).toEqual(registered?.rule);
    }
    const counted = new Set(resolution.inventory.map((entry) => entry.construct));
    for (const construct of seeded) expect(counted.has(construct), construct).toBe(true);
    const dropNodes = seeded.filter(
      (construct) =>
        CONSTRUCT_RULE_REGISTRY.rules.find((rule) => rule.construct === construct)?.rule
          .disposition === "drop-with-notice",
    );
    expect(resolution.dropLedger.map((entry) => entry.construct)).toEqual(dropNodes);
    expect(
      Object.keys(NORMALIZED_DIRECTIVE_NODE_KINDS).some((name) => counted.has(`directive:${name}`)),
    ).toBe(false);
  });

  it("refuses an IR of another schema version", () => {
    const future = { ...irWith([]), schemaVersion: 2 } as unknown as ConversionIrV1;
    expect(() => resolveConversionIr(future)).toThrow(
      expect.objectContaining({ code: "conversion-ir-schema-unsupported" }),
    );
  });

  it("records a judged-answer drop rule with judged-answer provenance in the drop ledger", () => {
    const resolution = resolveConversionIr(irWith([guideDocument()]), {
      overrides: [
        {
          kind: "construct",
          construct: "directive:nemo-gallery",
          override: { rule: "drop", reason: "The gallery is generated from the model catalog." },
          provenance: { source: "judged-answer", unitId: "unit:node:gallery-1" },
        },
      ],
    });
    expect(resolution.dropLedger.find((entry) => entry.nodeId === "gallery-1")).toMatchObject({
      construct: "directive:nemo-gallery",
      reason: { code: "judged-answer", text: "The gallery is generated from the model catalog." },
    });
    expect(resolution.units.map((unit) => unit.id)).not.toContain("unit:node:gallery-1");
  });

  it("checks the subtree of a dropped node for reader defects", () => {
    const droppedWith = (child: ConversionBlock): ConversionIrV1 =>
      irWith([
        document("doc-dropped", [
          {
            id: "todo-x",
            kind: "directive",
            name: "todo",
            options: [],
            span: at(),
            body: { kind: "blocks", children: [child] },
          },
        ]),
      ]);
    expect(() =>
      resolveConversionIr(
        droppedWith({ id: "weird", kind: "callout", span: at() } as unknown as ConversionBlock),
      ),
    ).toThrow(expect.objectContaining({ code: "conversion-unknown-node-kind", nodeId: "weird" }));
    expect(() =>
      resolveConversionIr(
        droppedWith({
          id: "generic-include",
          kind: "directive",
          name: "literalinclude",
          argument: "example.py",
          options: [],
          body: { kind: "none" },
          span: at(),
        }),
      ),
    ).toThrow(
      expect.objectContaining({
        code: "conversion-directive-not-normalized",
        nodeId: "generic-include",
      }),
    );
    expect(() =>
      resolveConversionIr(
        droppedWith({ id: "todo-x", kind: "paragraph", children: [], span: at() }),
      ),
    ).toThrow(expect.objectContaining({ code: "conversion-ir-id-duplicate", nodeId: "todo-x" }));
    const clean = resolveConversionIr(
      droppedWith({ id: "todo-x-p", kind: "paragraph", children: [], span: at() }),
    );
    expect(clean.nodes.map((node) => node.nodeId)).toEqual(["todo-x"]);
  });

  it("refuses duplicate node ids and keeps node and substitution unit ids apart", () => {
    const custom = (id: string): ConversionBlock => ({
      id,
      kind: "directive",
      name: "nemo-gallery",
      options: [],
      body: { kind: "none" },
      span: at(),
    });
    expect(() =>
      resolveConversionIr(irWith([document("doc-dup", [custom("x"), custom("x")])])),
    ).toThrow(expect.objectContaining({ code: "conversion-ir-id-duplicate", nodeId: "x" }));
    expect(() =>
      resolveConversionIr(
        irWith([document("doc-a", [custom("x")]), document("doc-b", [custom("x")])]),
      ),
    ).toThrow(expect.objectContaining({ code: "conversion-ir-id-duplicate" }));

    const computed = {
      name: "release",
      value: { kind: "computed" as const, expression: "nemo.__version__" },
      origin: {
        kind: "configuration" as const,
        path: "docs/conf.py",
        span: { startLine: 9, endLine: 9 },
      },
    };
    const resolution = resolveConversionIr(
      irWith([document("doc-ns", [custom("substitution:release")])], {
        substitutions: [computed],
      }),
    );
    expect(resolution.units.map((unit) => unit.id)).toEqual([
      "unit:node:substitution:release",
      "unit:substitution:release",
    ]);
    expect(() => resolveConversionIr(irWith([], { substitutions: [computed, computed] }))).toThrow(
      expect.objectContaining({ code: "conversion-ir-id-duplicate" }),
    );
  });

  it("refuses a substitution rule for a substitution the IR does not have", () => {
    expect(() =>
      resolveConversionIr(irWith([guideDocument()]), {
        overrides: [
          {
            kind: "substitution",
            name: "release",
            literal: "26.10",
            provenance: { source: "operator" },
          },
        ],
      }),
    ).toThrow(
      expect.objectContaining({
        code: "conversion-override-invalid",
        construct: "substitution:release",
      }),
    );
  });

  it("refuses an unknown node kind nested inside a converted directive", () => {
    const ir = irWith([
      document("doc-bad", [
        {
          id: "note-x",
          kind: "directive",
          name: "note",
          options: [],
          span: at(),
          body: {
            kind: "blocks",
            children: [{ id: "weird", kind: "callout", span: at() } as unknown as ConversionBlock],
          },
        },
      ]),
    ]);
    expect(() => resolveConversionIr(ir)).toThrow(
      expect.objectContaining({ code: "conversion-unknown-node-kind", nodeId: "weird" }),
    );
  });
});
