// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  compareRstStaticStructure,
  validateRstStaticGraph,
} from "../src/rst-authoring/static-comparison.js";

const encode = (value: string) => new TextEncoder().encode(value);
const baseGuide = [
  ".. _guide:",
  "",
  "Guide",
  "=====",
  "",
  "Install the toolkit before examples.",
  "",
  ".. tabs::",
  "",
  "   .. tab:: pip",
  "",
  "      :ref:`not-a-real-reference` stays opaque.",
  "",
  ".. include:: snippet.rst",
  "",
  "See :doc:`index` and :ref:`guide`.",
  "",
].join("\n");
const editedGuide = baseGuide.replace(
  "Install the toolkit before examples.",
  "Install the tested toolkit before examples.",
);
const mystConf = [
  'project = "Guide"',
  'root_doc = "index"',
  'source_suffix = [".rst", ".md"]',
  'extensions = ["myst_parser"]',
  'myst_enable_extensions = ["colon_fence"]',
  "",
].join("\n");

function fixture(overrides: Record<string, string | undefined> = {}) {
  const files: Record<string, string | undefined> = {
    "docs/conf.py": 'project = "Guide"\nroot_doc = "index"\nsource_suffix = [".rst"]\n',
    "docs/index.rst": "Index\n=====\n\n.. toctree::\n   :maxdepth: 1\n\n   guide\n",
    "docs/guide.rst": baseGuide,
    "docs/snippet.rst": "Snippet\n=======\n",
    ...overrides,
  };
  return {
    path: "docs/guide.rst",
    documentationRoot: "docs",
    candidate: encode(
      files["docs/guide.rst"] === baseGuide ? editedGuide : files["docs/guide.rst"]!,
    ),
    readTracked: async (path: string) =>
      files[path] === undefined ? undefined : encode(files[path]),
  };
}

describe("bounded RST static comparison and graph", () => {
  it("preserves supported labels, roles, include and toctree while disclosing opaque tabs", async () => {
    const compared = compareRstStaticStructure(
      "docs/guide.rst",
      encode(baseGuide),
      encode(editedGuide),
    );
    expect(compared).toMatchObject({ state: "limited", opaqueRegions: 1 });
    expect(compared.checkedKinds).toEqual(
      expect.arrayContaining([
        "labels",
        "doc/ref",
        "toctree",
        "include/literalinclude",
        "directive-options",
      ]),
    );
    const graph = await validateRstStaticGraph(fixture());
    expect(graph.state).toBe("limited");
    expect(graph.limitations).toEqual(
      expect.arrayContaining([expect.stringContaining("opaque-directive")]),
    );
    expect(graph.checkedKinds).toEqual(
      expect.arrayContaining(["toctree", "doc/ref", "include/literalinclude"]),
    );
  });

  it.each([
    [
      "doc role",
      "See :doc:`index` and :ref:`guide`.",
      "See :doc:`ghost` and :ref:`guide`.",
      "missing-target",
    ],
    [
      "ref role",
      "See :doc:`index` and :ref:`guide`.",
      "See :doc:`index` and :ref:`ghost`.",
      "missing-target",
    ],
    ["include escape", ".. include:: snippet.rst", ".. include:: ../../escape.rst", "path-escape"],
    [
      "literalinclude escape",
      ".. include:: snippet.rst",
      ".. literalinclude:: ../../escape.py",
      "path-escape",
    ],
  ])("checks a supported %s after opaque tabs", async (_label, before, after, code) => {
    const graph = fixture({ "docs/guide.rst": baseGuide.replace(before, after) });
    await expect(validateRstStaticGraph(graph)).rejects.toMatchObject({ code });
  });

  it("detects a toctree cycle after opaque tabs", async () => {
    const graph = fixture({
      "docs/guide.rst": `${baseGuide}\n.. toctree::\n\n   index\n`,
    });
    await expect(validateRstStaticGraph(graph)).rejects.toMatchObject({ code: "cycle" });
  });

  it("resolves a ref label from a tracked RST include", async () => {
    const graph = fixture({
      "docs/guide.rst": baseGuide.replace(":ref:`guide`", ":ref:`included-label`"),
      "docs/snippet.rst": ".. _included-label:\n\nIncluded source.\n",
    });
    const result = await validateRstStaticGraph(graph);
    expect(result.state).toBe("limited");
    expect(result.limitations).toEqual(
      expect.arrayContaining([expect.stringContaining("opaque-directive")]),
    );
  });

  it.each([
    ["start-after", "   :start-after: CUT"],
    ["literal", "   :literal:"],
    ["code", "   :code: python"],
    ["parser", "   :parser: rst"],
    ["blank-separated option", "\n   :start-after: CUT"],
    ["masked nested body", "\n   .. custom::\n\n      Nested text."],
  ])("refuses an option-bearing RST include before registering %s labels", async (_name, body) => {
    const graph = fixture({
      "docs/guide.rst": baseGuide
        .replace(".. include:: snippet.rst", `.. include:: snippet.rst\n${body}`)
        .replace(":ref:`guide`", ":ref:`excluded-label`"),
      "docs/snippet.rst": ".. _excluded-label:\n\nCUT\n\nIncluded text.\n",
    });
    await expect(validateRstStaticGraph(graph)).rejects.toMatchObject({
      code: "unsupported-directive",
    });
  });

  it.each(["```", ":::"])("refuses an option-bearing MyST include in a %s fence", async (fence) => {
    const graph = fixture({
      "docs/conf.py": mystConf,
      "docs/index.rst": "Index\n=====\n\n.. toctree::\n\n   guide\n   included-md\n",
      "docs/included-md.md": `${fence}{include} snippet.rst\n:start-after: CUT\n${fence}\n`,
      "docs/snippet.rst": ".. _excluded-label:\n\nCUT\n\nIncluded text.\n",
    });
    await expect(validateRstStaticGraph(graph)).rejects.toMatchObject({
      code: "unsupported-directive",
    });
  });

  it("follows an optionless MyST include to a tracked RST label", async () => {
    const graph = fixture({
      "docs/conf.py": mystConf,
      "docs/index.rst": "Index\n=====\n\n.. toctree::\n\n   guide\n   included-md\n",
      "docs/guide.rst": baseGuide
        .replace(".. include:: snippet.rst", ".. literalinclude:: snippet.rst")
        .replace(":ref:`guide`", ":ref:`myst-label`"),
      "docs/included-md.md": "```{include} snippet.rst\n```\n",
      "docs/snippet.rst": ".. _myst-label:\n\nIncluded text.\n",
    });
    const result = await validateRstStaticGraph(graph);
    expect(result.state).toBe("limited");
  });

  it("still rejects missing included refs, escapes, and include cycles", async () => {
    const missing = fixture({
      "docs/guide.rst": baseGuide.replace(":ref:`guide`", ":ref:`included-label`"),
    });
    await expect(validateRstStaticGraph(missing)).rejects.toMatchObject({ code: "missing-target" });
    const cycle = fixture({
      "docs/snippet.rst": ".. include:: guide.rst\n",
    });
    await expect(validateRstStaticGraph(cycle)).rejects.toMatchObject({ code: "cycle" });
    const escapedInclude = fixture({
      "docs/snippet.rst": ".. include:: ../../outside.rst\n",
    });
    await expect(validateRstStaticGraph(escapedInclude)).rejects.toMatchObject({
      code: "path-escape",
    });
    const duplicate = fixture({
      "docs/snippet.rst": ".. _guide:\n\nDuplicate label.\n",
    });
    await expect(validateRstStaticGraph(duplicate)).rejects.toMatchObject({
      code: "duplicate-reference-label",
    });
  });

  it("keeps literalinclude content outside the RST label graph", async () => {
    const graph = fixture({
      "docs/guide.rst": baseGuide
        .replace(".. include:: snippet.rst", ".. literalinclude:: snippet.rst")
        .replace(":ref:`guide`", ":ref:`literal-label`"),
      "docs/snippet.rst": ".. _literal-label:\n\nLiteral content.\n",
    });
    await expect(validateRstStaticGraph(graph)).rejects.toMatchObject({ code: "missing-target" });
  });

  it("rejects an unrelated missing ref even with a non-RST include", async () => {
    const graph = fixture({
      "docs/guide.rst": baseGuide
        .replace(".. include:: snippet.rst", ".. include:: snippet.inc")
        .replace(":ref:`guide`", ":ref:`unrelated-missing`"),
      "docs/snippet.inc": "Unparsed include content.\n",
    });
    await expect(validateRstStaticGraph(graph)).rejects.toMatchObject({ code: "missing-target" });
  });

  it("rejects a supported option or label mutation outside selected prose", () => {
    const withToctree = `${baseGuide}\n.. toctree::\n   :maxdepth: 1\n\n   index\n`;
    const edited = withToctree.replace("Install the toolkit", "Install the tested toolkit");
    for (const candidate of [
      edited.replace(":maxdepth: 1", ":maxdepth: 2"),
      edited.replace(".. _guide:", ".. _changed:"),
    ]) {
      expect(() =>
        compareRstStaticStructure("docs/guide.rst", encode(withToctree), encode(candidate)),
      ).toThrowError(expect.objectContaining({ code: "rst-preservation-mismatch" }));
    }
  });

  it("ignores role-looking literal code and validates malformed supported options", async () => {
    const source = `${baseGuide}\n.. code-block:: text\n\n   :ref:\`literal-only\`\n`;
    const candidate = source.replace("Install the toolkit", "Install the tested toolkit");
    expect(
      compareRstStaticStructure("docs/guide.rst", encode(source), encode(candidate)).state,
    ).toBe("limited");
    const malformed = fixture({
      "docs/guide.rst": `${baseGuide}\n.. toctree::\n   :maxdepth 2\n\n   index\n`,
    });
    await expect(validateRstStaticGraph(malformed)).rejects.toMatchObject({
      code: "malformed-directive",
    });
  });

  it("reports root discovery limitation while still checking selected supported edges", async () => {
    const graph = fixture({ "docs/conf.py": undefined });
    const result = await validateRstStaticGraph(graph);
    expect(result.state).toBe("limited");
    expect(result.limitations).toEqual(
      expect.arrayContaining([expect.stringContaining("root-document-unresolved")]),
    );
    const broken = fixture({
      "docs/conf.py": undefined,
      "docs/guide.rst": baseGuide.replace(":doc:`index`", ":doc:`missing`"),
    });
    await expect(validateRstStaticGraph(broken)).rejects.toMatchObject({ code: "missing-target" });
  });

  it("accepts an exact root-level RST file with an empty repository documentation root", async () => {
    const files: Record<string, string> = {
      "conf.py": 'project = "Guide"\nroot_doc = "index"\nsource_suffix = [".rst"]\n',
      "index.rst": "Index\n=====\n\n.. toctree::\n   :maxdepth: 1\n\n   guide\n",
      "guide.rst": baseGuide,
      "snippet.rst": "Snippet\n=======\n",
    };
    const readTracked = async (path: string) =>
      files[path] === undefined ? undefined : encode(files[path]);
    for (const documentationRoot of ["", "."]) {
      const result = await validateRstStaticGraph({
        path: "guide.rst",
        documentationRoot,
        candidate: encode(editedGuide),
        readTracked,
      });
      expect(result.state).toBe("limited");
      expect(result.limitations).toEqual(
        expect.arrayContaining([expect.stringContaining("opaque-directive")]),
      );
    }
  });
});
