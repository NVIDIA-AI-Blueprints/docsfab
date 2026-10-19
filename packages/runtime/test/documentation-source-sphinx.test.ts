// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { deriveDocumentationSourceApplicability } from "../src/repository/documentation-source-applicability.js";
import { validateSourceAwareStructuralDocumentation } from "../src/delivery/structural-documentation-validator.js";
import { temporaryRoots } from "./helpers/temp.js";

const roots = temporaryRoots();
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sphinxFixture = resolve(projectRoot, "test/fixtures/documentation-sources/sphinx");

async function writeSphinxDocs(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, contents] of Object.entries(files)) {
    const target = join(root, "docs", path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
}

async function applicabilityFor(
  root: string,
  changedPaths: readonly { path: string; status: "added" | "modified" | "deleted" }[],
) {
  return deriveDocumentationSourceApplicability({
    candidateRoot: root,
    repositoryIdentitySha256: digest("repository"),
    baseRevision: "a".repeat(40),
    candidateInputTreeSha256: digest("candidate"),
    changedPaths,
  });
}

describe("documentation source sphinx", () => {
  it("validates a positive-control RST/MyST Sphinx project: toctree, doc/ref, include, literalinclude", async () => {
    const root = await roots.create("docsfab-sphinx-positive-");
    await cp(sphinxFixture, root, { recursive: true });
    const changedPaths = [
      { path: "docs/index.rst", status: "modified" as const },
      { path: "docs/guide.rst", status: "modified" as const },
      { path: "docs/myst.md", status: "modified" as const },
    ];
    const applicability = await applicabilityFor(root, changedPaths);
    expect(applicability.roots).toEqual([
      expect.objectContaining({
        root: ".",
        adapterId: "sphinx",
        navigationMode: "explicit",
        limitations: [],
      }),
    ]);
    await expect(
      validateSourceAwareStructuralDocumentation(root, applicability.changedPaths, applicability),
    ).resolves.toEqual([
      { id: "documentation-source-applicability", status: "passed" },
      { id: "documentation-paths-readable", status: "passed" },
      { id: "documentation-relative-links", status: "passed" },
      { id: "documentation-navigation-targets", status: "passed" },
    ]);
  });

  it("rejects a missing Sphinx toctree target", async () => {
    const root = await roots.create("docsfab-sphinx-missing-");
    await writeSphinxDocs(root, {
      "conf.py": 'project = "Missing"\n',
      "index.rst": "Title\n=====\n\n.. toctree::\n\n   ghost\n",
    });
    const changedPaths = [{ path: "docs/index.rst", status: "modified" as const }];
    const applicability = await applicabilityFor(root, changedPaths);
    await expect(
      validateSourceAwareStructuralDocumentation(root, applicability.changedPaths, applicability),
    ).rejects.toMatchObject({
      check: "documentation-navigation-targets",
      status: "failed",
      message: expect.stringContaining("toctree target is missing"),
    });
  });

  it("rejects a Sphinx toctree cycle", async () => {
    const root = await roots.create("docsfab-sphinx-cycle-");
    await writeSphinxDocs(root, {
      "conf.py": 'project = "Cycle"\n',
      "index.rst": "Title\n=====\n\n.. toctree::\n\n   a\n",
      "a.rst": "A\n=\n\n.. toctree::\n\n   b\n",
      "b.rst": "B\n=\n\n.. toctree::\n\n   a\n",
    });
    const changedPaths = [{ path: "docs/index.rst", status: "modified" as const }];
    const applicability = await applicabilityFor(root, changedPaths);
    await expect(
      validateSourceAwareStructuralDocumentation(root, applicability.changedPaths, applicability),
    ).rejects.toMatchObject({
      check: "documentation-navigation-targets",
      status: "failed",
      message: expect.stringContaining("cycle detected"),
    });
  });

  it("rejects a Sphinx toctree target that escapes the documentation source root", async () => {
    const root = await roots.create("docsfab-sphinx-escape-");
    await writeSphinxDocs(root, {
      "conf.py": 'project = "Escape"\n',
      "index.rst": "Title\n=====\n\n.. toctree::\n\n   ../../escape\n",
    });
    const changedPaths = [{ path: "docs/index.rst", status: "modified" as const }];
    const applicability = await applicabilityFor(root, changedPaths);
    await expect(
      validateSourceAwareStructuralDocumentation(root, applicability.changedPaths, applicability),
    ).rejects.toMatchObject({
      check: "documentation-navigation-targets",
      status: "failed",
      message: expect.stringContaining("escapes the documentation source root"),
    });
  });

  it("rejects an ambiguous Sphinx configuration location", async () => {
    const root = await roots.create("docsfab-sphinx-ambiguous-loc-");
    await writeFile(join(root, "conf.py"), 'project = "Root"\n');
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs/conf.py"), 'project = "Nested"\n');
    await writeFile(join(root, "docs/index.rst"), "Title\n=====\n");
    const changedPaths = [{ path: "docs/index.rst", status: "modified" as const }];
    const applicability = await applicabilityFor(root, changedPaths);
    await expect(
      validateSourceAwareStructuralDocumentation(root, applicability.changedPaths, applicability),
    ).rejects.toMatchObject({
      check: "documentation-source-applicability",
      status: "limitation",
      message: expect.stringContaining("exactly one conf.py"),
    });
  });

  it("rejects a computed, non-literal Sphinx conf.py value", async () => {
    const root = await roots.create("docsfab-sphinx-computed-");
    await writeSphinxDocs(root, {
      "conf.py": "source_suffix = get_suffixes()\n",
      "index.rst": "Title\n=====\n",
    });
    const changedPaths = [{ path: "docs/index.rst", status: "modified" as const }];
    const applicability = await applicabilityFor(root, changedPaths);
    await expect(
      validateSourceAwareStructuralDocumentation(root, applicability.changedPaths, applicability),
    ).rejects.toMatchObject({
      check: "documentation-source-applicability",
      status: "limitation",
      message: expect.stringContaining("source_suffix"),
    });
  });

  it("rejects a custom Sphinx directive or domain outside the enumerated support set", async () => {
    const root = await roots.create("docsfab-sphinx-custom-directive-");
    await writeSphinxDocs(root, {
      "conf.py": 'project = "Custom"\n',
      "index.rst": "Title\n=====\n\n.. note::\n\n   Body text.\n",
    });
    const changedPaths = [{ path: "docs/index.rst", status: "modified" as const }];
    const applicability = await applicabilityFor(root, changedPaths);
    await expect(
      validateSourceAwareStructuralDocumentation(root, applicability.changedPaths, applicability),
    ).rejects.toMatchObject({
      check: "documentation-source-applicability",
      status: "limitation",
      message: expect.stringContaining("Unsupported Sphinx directive or domain: note"),
    });
  });

  it("treats a missing toctree target as an out-of-scope generated API section when autodoc-like extensions are configured", async () => {
    const root = await roots.create("docsfab-sphinx-generated-");
    await writeSphinxDocs(root, {
      "conf.py": 'extensions = ["sphinx.ext.autodoc"]\n',
      "index.rst": "Title\n=====\n\n.. toctree::\n\n   api/generated\n",
    });
    const changedPaths = [{ path: "docs/index.rst", status: "modified" as const }];
    const applicability = await applicabilityFor(root, changedPaths);
    await expect(
      validateSourceAwareStructuralDocumentation(root, applicability.changedPaths, applicability),
    ).rejects.toMatchObject({
      check: "documentation-navigation-targets",
      status: "limitation",
      message: expect.stringContaining("generated content outside bounded scope"),
    });
  });

  it("keeps an unrelated broken Sphinx document outside the validated closure", async () => {
    const root = await roots.create("docsfab-sphinx-unrelated-");
    await writeSphinxDocs(root, {
      "conf.py": 'project = "Unrelated"\n',
      "index.rst": "Title\n=====\n\nHello world.\n",
      "broken.rst": "Broken\n======\n\n.. toctree::\n\n   does-not-exist\n",
    });
    const changedPaths = [{ path: "docs/index.rst", status: "modified" as const }];
    const applicability = await applicabilityFor(root, changedPaths);
    await expect(
      validateSourceAwareStructuralDocumentation(root, applicability.changedPaths, applicability),
    ).resolves.toEqual([
      { id: "documentation-source-applicability", status: "passed" },
      { id: "documentation-paths-readable", status: "passed" },
      { id: "documentation-relative-links", status: "passed" },
      { id: "documentation-navigation-targets", status: "passed" },
    ]);
  });

  it("rejects a Sphinx :ref: target that is missing from every visited document", async () => {
    const root = await roots.create("docsfab-sphinx-missing-ref-");
    await writeSphinxDocs(root, {
      "conf.py": 'project = "Refs"\n',
      "index.rst": "Title\n=====\n\nSee :ref:`missing-anchor`.\n",
    });
    const changedPaths = [{ path: "docs/index.rst", status: "modified" as const }];
    const applicability = await applicabilityFor(root, changedPaths);
    await expect(
      validateSourceAwareStructuralDocumentation(root, applicability.changedPaths, applicability),
    ).rejects.toMatchObject({
      check: "documentation-navigation-targets",
      status: "failed",
      message: expect.stringContaining("ref target is missing: missing-anchor"),
    });
  });

  it("resolves Sphinx toctree/doc targets relative to the referencing document directory, not the source root", async () => {
    const root = await roots.create("docsfab-sphinx-divergent-paths-");
    await writeSphinxDocs(root, {
      "conf.py": 'project = "Divergent"\n',
      "index.rst": "Title\n=====\n\n.. toctree::\n\n   sub/guide\n   guide\n",
      "guide.rst": ".. _root-guide:\n\nRoot Guide\n==========\n",
      "sub/guide.rst": ".. _sub-guide:\n\nSub Guide\n=========\n\nSee :doc:`../only-root`.\n",
      "only-root.rst": ".. _only-root:\n\nOnly Root\n=========\n",
    });
    const changedPaths = [
      { path: "docs/index.rst", status: "modified" as const },
      { path: "docs/sub/guide.rst", status: "modified" as const },
    ];
    const applicability = await applicabilityFor(root, changedPaths);
    await expect(
      validateSourceAwareStructuralDocumentation(root, applicability.changedPaths, applicability),
    ).resolves.toEqual([
      { id: "documentation-source-applicability", status: "passed" },
      { id: "documentation-paths-readable", status: "passed" },
      { id: "documentation-relative-links", status: "passed" },
      { id: "documentation-navigation-targets", status: "passed" },
    ]);
  });

  it("treats an RST-only plain-markdown root as an unrecognized-markup-extension limitation, not a silent pass", async () => {
    const root = await roots.create("docsfab-sphinx-plain-rst-");
    await writeFile(join(root, "README.rst"), "Title\n=====\n");
    const changedPaths = [{ path: "README.rst", status: "modified" as const }];
    const applicability = await applicabilityFor(root, changedPaths);
    expect(applicability.roots).toEqual([
      expect.objectContaining({
        root: ".",
        adapterId: "plain-markdown",
        limitations: ["unrecognized-markup-extension"],
      }),
    ]);
    await expect(
      validateSourceAwareStructuralDocumentation(root, applicability.changedPaths, applicability),
    ).rejects.toMatchObject({
      check: "documentation-source-applicability",
      status: "limitation",
    });
  });

  it("treats a Sphinx-shaped docs/guide.rst without conf.py as a limitation, not a silent pass", async () => {
    const root = await roots.create("docsfab-sphinx-no-conf-");
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs/guide.rst"), "Title\n=====\n\n.. toctree::\n\n   ghost\n");
    const changedPaths = [{ path: "docs/guide.rst", status: "modified" as const }];
    const applicability = await applicabilityFor(root, changedPaths);
    expect(applicability.roots).toEqual([
      expect.objectContaining({
        root: ".",
        adapterId: "plain-markdown",
        limitations: ["unrecognized-markup-extension"],
      }),
    ]);
    await expect(
      validateSourceAwareStructuralDocumentation(root, applicability.changedPaths, applicability),
    ).rejects.toMatchObject({
      check: "documentation-source-applicability",
      status: "limitation",
    });
  });

  it("treats an unrecognized conf.py location (docs/source/conf.py) as a limitation, not a silent pass", async () => {
    const root = await roots.create("docsfab-sphinx-unrecognized-conf-loc-");
    await mkdir(join(root, "docs/source"), { recursive: true });
    await writeFile(join(root, "docs/source/conf.py"), 'project = "X"\n');
    await writeFile(
      join(root, "docs/source/guide.rst"),
      "Title\n=====\n\n.. toctree::\n\n   ghost\n",
    );
    const changedPaths = [{ path: "docs/source/guide.rst", status: "modified" as const }];
    const applicability = await applicabilityFor(root, changedPaths);
    expect(applicability.roots).toEqual([
      expect.objectContaining({
        root: ".",
        adapterId: "plain-markdown",
        limitations: ["unrecognized-markup-extension"],
      }),
    ]);
    await expect(
      validateSourceAwareStructuralDocumentation(root, applicability.changedPaths, applicability),
    ).rejects.toMatchObject({
      check: "documentation-source-applicability",
      status: "limitation",
    });
  });

  it("does not flag an unrelated README.rst as mixed ownership in a Fern-owned root", async () => {
    const root = await roots.create("docsfab-sphinx-fern-readme-rst-");
    await mkdir(join(root, "fern"), { recursive: true });
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(
      join(root, "fern/docs.yml"),
      "navigation:\n  - page: Root\n    path: ../docs/root.md\n",
    );
    await writeFile(join(root, "docs/root.md"), "# Root\n");
    await writeFile(join(root, "README.rst"), "Unrelated\n=========\n");
    const changedPaths = [
      { path: "fern/docs.yml", status: "modified" as const },
      { path: "README.rst", status: "modified" as const },
    ];
    const applicability = await applicabilityFor(root, changedPaths);
    expect(applicability.roots).toEqual([
      expect.objectContaining({ root: ".", adapterId: "fern", limitations: [] }),
    ]);
    await expect(
      validateSourceAwareStructuralDocumentation(root, applicability.changedPaths, applicability),
    ).resolves.toEqual([
      { id: "documentation-source-applicability", status: "passed" },
      { id: "documentation-paths-readable", status: "passed" },
      { id: "documentation-relative-links", status: "passed" },
      { id: "documentation-navigation-targets", status: "passed" },
    ]);
  });

  it("rejects a glob toctree entry", async () => {
    const root = await roots.create("docsfab-sphinx-glob-");
    await writeSphinxDocs(root, {
      "conf.py": 'project = "Glob"\n',
      "index.rst": "Title\n=====\n\n.. toctree::\n\n   api/*\n",
    });
    const changedPaths = [{ path: "docs/index.rst", status: "modified" as const }];
    const applicability = await applicabilityFor(root, changedPaths);
    await expect(
      validateSourceAwareStructuralDocumentation(root, applicability.changedPaths, applicability),
    ).rejects.toMatchObject({
      check: "documentation-navigation-targets",
      status: "failed",
      message: expect.stringContaining("Unsupported glob or empty toctree entry"),
    });
  });

  it("rejects a single-level toctree escape above the Sphinx source root (kills assertSphinxPathWithinRoot deletion)", async () => {
    const root = await roots.create("docsfab-sphinx-single-escape-");
    await writeFile(join(root, "outside.rst"), "Outside\n=======\n");
    await writeSphinxDocs(root, {
      "conf.py": 'project = "SingleEscape"\n',
      "index.rst": "Title\n=====\n\n.. toctree::\n\n   ../outside\n",
    });
    const changedPaths = [{ path: "docs/index.rst", status: "added" as const }];
    const applicability = await applicabilityFor(root, changedPaths);
    await expect(
      validateSourceAwareStructuralDocumentation(root, applicability.changedPaths, applicability),
    ).rejects.toMatchObject({
      check: "documentation-navigation-targets",
      status: "failed",
      message: expect.stringContaining("escapes the documentation source root"),
    });
  });

  it("rejects an include directive missing its target", async () => {
    const root = await roots.create("docsfab-sphinx-missing-include-arg-");
    await writeSphinxDocs(root, {
      "conf.py": 'project = "MissingArg"\n',
      "index.rst": "Title\n=====\n\n.. include::\n",
    });
    const changedPaths = [{ path: "docs/index.rst", status: "modified" as const }];
    const applicability = await applicabilityFor(root, changedPaths);
    await expect(
      validateSourceAwareStructuralDocumentation(root, applicability.changedPaths, applicability),
    ).rejects.toMatchObject({
      check: "documentation-navigation-targets",
      status: "failed",
      message: expect.stringContaining("include directive is missing its target"),
    });
  });

  it("rejects a label defined in more than one document", async () => {
    const root = await roots.create("docsfab-sphinx-duplicate-label-");
    await writeSphinxDocs(root, {
      "conf.py": 'project = "Duplicate"\n',
      "index.rst": ".. _shared:\n\nTitle\n=====\n\n.. toctree::\n\n   other\n",
      "other.rst": ".. _shared:\n\nOther\n=====\n",
    });
    const changedPaths = [{ path: "docs/index.rst", status: "modified" as const }];
    const applicability = await applicabilityFor(root, changedPaths);
    await expect(
      validateSourceAwareStructuralDocumentation(root, applicability.changedPaths, applicability),
    ).rejects.toMatchObject({
      check: "documentation-relative-links",
      status: "failed",
      message: expect.stringContaining("shared"),
    });
  });

  it("rejects conflicting root_doc and master_doc literal values", async () => {
    const root = await roots.create("docsfab-sphinx-ambiguous-value-");
    await writeSphinxDocs(root, {
      "conf.py": 'root_doc = "index"\nmaster_doc = "main"\n',
      "index.rst": "Title\n=====\n",
    });
    const changedPaths = [{ path: "docs/index.rst", status: "modified" as const }];
    const applicability = await applicabilityFor(root, changedPaths);
    await expect(
      validateSourceAwareStructuralDocumentation(root, applicability.changedPaths, applicability),
    ).rejects.toMatchObject({
      check: "documentation-source-applicability",
      status: "limitation",
      message: expect.stringContaining("root_doc and master_doc"),
    });
  });
});
