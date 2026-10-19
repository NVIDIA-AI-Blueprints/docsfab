// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { canonicalDigest } from "../src/content-ir/canonical.js";
import { decodeContentIndex, decodeContentIndexV3 } from "../src/content-ir/decoder.js";
import { diffContentIndexesVersioned } from "../src/content-ir/diff.js";
import { buildContentIndexV2, buildContentIndexV3 } from "../src/content-ir/indexer.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import { commitFixture, initFixtureRepo } from "./helpers/git.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = resolve(projectRoot, "test/fixtures/documentation-sources/rst");

describe("Content IR v3 RST and MyST", () => {
  it("indexes finite RST/MyST structures with stable locations and local roles", async () => {
    const repository = await fixtureRepository();
    try {
      const index = await buildRevision(repository, "HEAD");
      expect(index.schemaVersion).toBe(3);
      expect(index.evidence.documentCount).toBe(3);
      const documents = new Map(
        index.nodes
          .filter((node) => node.kind === "document")
          .map((node) => [node.sourcePath, node]),
      );
      const indexDocument = documents.get("index.rst")!;
      const guide = documents.get("guide.rst")!;
      const myst = documents.get("myst.md")!;
      expect(indexDocument.format).toBe("rst");
      expect(indexDocument.anchors).toEqual(expect.arrayContaining(["overview"]));
      expect(indexDocument.directives).toEqual([
        { name: "toctree", line: 11 },
        { name: "include", line: 15 },
        { name: "literalinclude", line: 17 },
        { name: "code-block", line: 19 },
      ]);
      expect(indexDocument.codeBlocks).toEqual([
        { language: "typescript", startLine: 19, endLine: 22 },
      ]);
      expect(myst.format).toBe("myst");
      expect(myst.codeBlocks).toEqual([{ language: "python", startLine: 6, endLine: 8 }]);
      const overview = index.nodes.find(
        (node) =>
          node.kind === "section" && node.sourcePath === "index.rst" && node.anchor === "overview",
      )!;
      const guideSection = index.nodes.find(
        (node) =>
          node.kind === "section" &&
          node.sourcePath === "guide.rst" &&
          node.anchor === "guide-section",
      )!;
      const mystSection = index.nodes.find(
        (node) =>
          node.kind === "section" &&
          node.sourcePath === "myst.md" &&
          node.anchor === "myst-section",
      )!;
      expect(index.edges).toContainEqual({
        kind: "outbound-link",
        from: overview.id,
        to: guideSection.id,
      });
      expect(index.edges).toContainEqual({
        kind: "outbound-link",
        from: overview.id,
        to: guide.id,
      });
      expect(index.edges).toContainEqual({
        kind: "outbound-link",
        from: mystSection.id,
        to: guideSection.id,
      });
      expect(decodeContentIndexV3(JSON.parse(JSON.stringify(index)))).toEqual(index);
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("rejects malformed and relevant unsupported RST/MyST syntax", async () => {
    await expect(
      indexFiles({ "index.rst": "Heading\n=======\n\n.. _missing\n" }),
    ).rejects.toMatchObject({
      code: "unsupported-document-syntax",
    });
    await expect(
      indexFiles({ "index.rst": "Heading\n=======\n\n.. custom:: value\n" }),
    ).rejects.toMatchObject({
      code: "unsupported-document-syntax",
    });
    await expect(
      indexFiles({ "index.rst": "Heading\n=======\n\nSee :ref:`missing`.\n" }),
    ).rejects.toMatchObject({
      code: "broken-internal-target",
    });
    await expect(
      indexFiles({ "index.rst": "Heading\n=======\n\nSee :term:`value`.\n" }),
    ).rejects.toMatchObject({
      code: "unsupported-document-syntax",
    });
    await expect(
      indexFiles({ "index.md": "# Title\n\n:::{custom}\nbody\n:::\n" }),
    ).rejects.toMatchObject({
      code: "unsupported-document-syntax",
    });
    await expect(
      indexFiles({ "index.md": "# Title\n\n```{note}\nbody\n```\n" }),
    ).rejects.toMatchObject({
      code: "unsupported-document-syntax",
    });
    await expect(
      indexFiles({ "index.md": "# Title\n\nSee :ref:`target`.\n" }),
    ).rejects.toMatchObject({
      code: "unsupported-document-syntax",
    });
    await expect(
      indexFiles({ "index.md": "# Title\n\nSee {py:class}`value`.\n" }),
    ).rejects.toMatchObject({
      code: "unsupported-document-syntax",
    });
    await expect(
      indexFiles({ "index.md": "# Title\n\n:::{code-block} text\nbody\n" }),
    ).rejects.toMatchObject({
      code: "unsupported-document-syntax",
    });
    await expect(
      indexFiles({
        "index.md":
          "# Title\n\n```{toctree}\nSee {ref}`target`.\n```{code-block} text\n{ref}`ghost`\n```\n```\n",
        "target.rst": ".. _target:\n\nTarget\n======\n",
      }),
    ).rejects.toMatchObject({
      code: "unsupported-document-syntax",
    });
  });

  it("does not resolve role-looking literals inside RST or MyST code blocks", async () => {
    const rst = await indexFiles({
      "index.rst": "Title\n=====\n\n.. code-block:: text\n\n   :ref:`ghost`\n",
    });
    const myst = await indexFiles({
      "index.md":
        "# Title\n\n```text\n{ref}`ghost`\n```\n\n```{code-block} text\n{ref}`ghost`\n```\n",
    });
    expect(rst.edges.some((edge) => edge.kind === "outbound-link")).toBe(false);
    expect(myst.edges.some((edge) => edge.kind === "outbound-link")).toBe(false);
  });

  it("recognizes role-only MyST as MyST and resolves its local label", async () => {
    const index = await indexFiles({
      "index.md": "# Title\n\nSee {ref}`target`.\n",
      "target.rst": ".. _target:\n\nTarget\n======\n",
    });
    const indexDocument = index.nodes.find(
      (node) => node.kind === "document" && node.sourcePath === "index.md",
    );
    if (indexDocument?.kind !== "document") throw new Error("expected indexed MyST document");
    const target = index.nodes.find(
      (node) =>
        node.kind === "section" && node.sourcePath === "target.rst" && node.anchor === "target",
    )!;
    const title = index.nodes.find(
      (node) =>
        node.kind === "section" && node.sourcePath === "index.md" && node.anchor === "title",
    )!;
    expect(indexDocument.format).toBe("myst");
    expect(index.edges).toContainEqual({ kind: "outbound-link", from: title.id, to: target.id });
  });

  it("masks MyST role-looking literals and resolves roles in supported directive bodies", async () => {
    const literals = await indexFiles({
      "index.md":
        "---\ndescription: 'Literal {ref}`ghost`'\n---\n(top)=\n# Title\n\nLiteral ``{ref}`ghost`` text.\n\n<!-- {ref}`ghost` -->\n\n<!-- comment\n{ref}`ghost`\nend -->\n",
    });
    expect(literals.edges.some((edge) => edge.kind === "outbound-link")).toBe(false);

    const nested = await indexFiles({
      "index.md":
        "# Title\n\n````{toctree}\nSee {ref}`target`\n\n```{code-block} text\n{ref}`ghost`\n```\n````\n",
      "target.rst": ".. _target:\n\nTarget\n======\n",
    });
    const title = nested.nodes.find(
      (node) =>
        node.kind === "section" && node.sourcePath === "index.md" && node.anchor === "title",
    )!;
    const target = nested.nodes.find(
      (node) =>
        node.kind === "section" && node.sourcePath === "target.rst" && node.anchor === "target",
    )!;
    const code = nested.nodes.find(
      (node) => node.kind === "document" && node.sourcePath === "index.md",
    );
    if (code?.kind !== "document") throw new Error("expected indexed directive document");
    expect(nested.edges).toContainEqual({ kind: "outbound-link", from: title.id, to: target.id });
    expect(code.codeBlocks).toContainEqual({ language: "text", startLine: 6, endLine: 8 });
  });

  it("keeps V1/V2 decoding strict and emits a V3 diff when either input is V3", async () => {
    const repository = await fixtureRepository();
    try {
      const before = await buildRevision(repository, "HEAD");
      const historicalV2 = await buildV2Revision(repository, "HEAD");
      await writeFile(
        join(repository, "guide.rst"),
        ".. _guide-section:\n\nChanged guide\n=============\n",
      );
      await commitFixture(repository, "change guide");
      const after = await buildRevision(repository, "HEAD");
      const diff = diffContentIndexesVersioned(before, after);
      expect(diff.schemaVersion).toBe(3);
      expect(diffContentIndexesVersioned(historicalV2, before).schemaVersion).toBe(3);
      expect(diff.documents).toContainEqual(
        expect.objectContaining({
          sourcePath: "guide.rst",
          regions: expect.arrayContaining(["headings"]),
        }),
      );
      const poisoned: Record<string, unknown> = { ...structuredClone(before) };
      poisoned.schemaVersion = 4;
      expect(() => decodeContentIndex(poisoned)).toThrow();
      const rstAsV2: Record<string, unknown> = { ...structuredClone(before) };
      rstAsV2.schemaVersion = 2;
      rstAsV2.indexDigest = canonicalDigest({
        schemaVersion: 2,
        repository: rstAsV2.repository,
        nodes: rstAsV2.nodes,
        edges: rstAsV2.edges,
      });
      (rstAsV2.evidence as Record<string, unknown>).indexDigest = rstAsV2.indexDigest;
      expect(() => decodeContentIndex(rstAsV2)).toThrow();
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });
});

async function indexFiles(files: Record<string, string>) {
  const repository = await createRepository(files);
  try {
    return await buildRevision(repository, "HEAD");
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
}

async function fixtureRepository(): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), "docsfab-content-ir-rst-"));
  await cp(fixtures, repository, { recursive: true });
  await initFixtureRepo(repository, {});
  return repository;
}

async function createRepository(files: Record<string, string>): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), "docsfab-content-ir-rst-"));
  await initFixtureRepo(repository, files);
  return repository;
}

async function buildRevision(repository: string, revision: string) {
  const workspace = await prepareRepositoryWorkspace(repository, revision);
  try {
    return await buildContentIndexV3({ workspace });
  } finally {
    await workspace.dispose();
  }
}

async function buildV2Revision(repository: string, revision: string) {
  const workspace = await prepareRepositoryWorkspace(repository, revision);
  try {
    return await buildContentIndexV2({ workspace });
  } finally {
    await workspace.dispose();
  }
}
