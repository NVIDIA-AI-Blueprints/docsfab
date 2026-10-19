// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { deriveDocumentationSourceApplicability } from "../src/repository/documentation-source-applicability.js";
import { resolveDocumentationSourceAdapter } from "../src/repository/documentation-source-support.js";
import {
  MkdocsConfigurationParseError,
  mkdocsNavigationLeaves,
  mkdocsPageRoute,
  parseMkdocsConfiguration,
} from "../src/repository/documentation-source-mkdocs.js";
import {
  scanMkdocsMaterialBlocks,
  validateMkdocsStructuralDocumentation,
} from "../src/delivery/structural-documentation-mkdocs.js";
import { validateSourceAwareStructuralDocumentation } from "../src/delivery/structural-documentation-validator.js";
import { temporaryRoots } from "./helpers/temp.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = resolve(projectRoot, "test/fixtures/documentation-sources/mkdocs");
const roots = temporaryRoots();
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

async function fixtureRoot(): Promise<string> {
  const root = await roots.create("docsfab-mkdocs-source-");
  await cp(fixtures, root, { recursive: true });
  return root;
}

type ChangedEntry = Readonly<{ path: string; status: "added" | "modified" | "deleted" }>;

function baseInput(root: string, changedPaths: readonly ChangedEntry[]) {
  return {
    candidateRoot: root,
    repositoryIdentitySha256: digest("repository"),
    baseRevision: "a".repeat(40),
    candidateInputTreeSha256: digest("candidate"),
    changedPaths,
  };
}

const PASSED_RESULTS = [
  { id: "documentation-source-applicability", status: "passed" },
  { id: "documentation-paths-readable", status: "passed" },
  { id: "documentation-relative-links", status: "passed" },
  { id: "documentation-navigation-targets", status: "passed" },
];

describe("documentation source mkdocs", () => {
  describe("parseMkdocsConfiguration", () => {
    it("applies literal defaults when docs_dir, nav, and use_directory_urls are absent", () => {
      const configuration = parseMkdocsConfiguration("site_name: Example\n");
      expect(configuration.docsDir).toBe("docs");
      expect(configuration.useDirectoryUrls).toBe(true);
      expect(configuration.navigationMode).toBe("automatic");
      expect(configuration.nav).toBeNull();
    });

    it("parses a custom docs_dir and nested explicit nav sections", () => {
      const source = [
        "docs_dir: documentation",
        "use_directory_urls: false",
        "nav:",
        "  - Home: index.md",
        "  - Guide:",
        "      - Setup: guide/setup.md",
        "      - guide/advanced.md",
      ].join("\n");
      const configuration = parseMkdocsConfiguration(source);
      expect(configuration.docsDir).toBe("documentation");
      expect(configuration.useDirectoryUrls).toBe(false);
      expect(configuration.navigationMode).toBe("explicit");
      expect(configuration.nav).not.toBeNull();
      expect(mkdocsNavigationLeaves(configuration.nav ?? [])).toEqual([
        { title: "Home", target: "index.md" },
        { title: "Setup", target: "guide/setup.md" },
        { title: null, target: "guide/advanced.md" },
      ]);
    });

    it("rejects a Python-tagged nav value", () => {
      const source = "nav:\n  - Home: !!python/name:material.extensions.emoji.to_svg\n";
      expect(() => parseMkdocsConfiguration(source)).toThrow(MkdocsConfigurationParseError);
      expect(() => parseMkdocsConfiguration(source)).toThrow(/unsupported YAML syntax/u);
    });

    it("rejects a YAML alias", () => {
      const source = ["defaults: &defaults", "  Home: index.md", "nav:", "  - *defaults"].join(
        "\n",
      );
      expect(() => parseMkdocsConfiguration(source)).toThrow(/aliases are unsupported/u);
    });

    it("rejects nav entries with an unsupported shape", () => {
      expect(() => parseMkdocsConfiguration("nav:\n  - 42\n")).toThrow(
        /supported literal scalar or single-key mapping/u,
      );
      expect(() =>
        parseMkdocsConfiguration("nav:\n  - Home: index.md\n    Extra: guide.md\n"),
      ).toThrow(/exactly one literal title key/u);
    });

    it("rejects an external URL used as a nav page path", () => {
      const source = "nav:\n  - External: https://example.com/page\n";
      expect(() => parseMkdocsConfiguration(source)).toThrow(
        /safe repository-relative literal path value/u,
      );
    });

    it("rejects a dot-segment docs_dir instead of silently mismatching later containment checks", () => {
      expect(() => parseMkdocsConfiguration("docs_dir: ./docs\n")).toThrow(
        /safe repository-relative literal path value/u,
      );
      expect(() => parseMkdocsConfiguration("docs_dir: docs/.\n")).toThrow(
        /safe repository-relative literal path value/u,
      );
    });

    it("rejects INHERIT-based configuration composition even without a local nav", () => {
      expect(() => parseMkdocsConfiguration("INHERIT: ../base.yml\n")).toThrow(
        /INHERIT-based configuration composition is unsupported/u,
      );
      expect(() =>
        parseMkdocsConfiguration("INHERIT: ../base.yml\nnav:\n  - Home: index.md\n"),
      ).toThrow(/INHERIT-based configuration composition is unsupported/u);
    });

    it("rejects nav nesting beyond the supported depth", () => {
      let block = "- Leaf: target.md\n";
      for (let level = 0; level < 18; level += 1) {
        const indented = block
          .split("\n")
          .filter(Boolean)
          .map((line) => `    ${line}`)
          .join("\n");
        block = `- Section:\n${indented}\n`;
      }
      const nested = block
        .split("\n")
        .filter(Boolean)
        .map((line) => `  ${line}`)
        .join("\n");
      const source = `nav:\n${nested}\n`;
      expect(() => parseMkdocsConfiguration(source)).toThrow(/maximum supported validation depth/u);
    });

    it("rejects automatic navigation combined with a non-empty plugins list", () => {
      expect(() => parseMkdocsConfiguration("plugins:\n  - awesome-pages\n")).toThrow(
        /plugins can silently reorder pages/u,
      );
      const emptyPlugins = parseMkdocsConfiguration("plugins: []\n");
      expect(emptyPlugins.navigationMode).toBe("automatic");
    });
  });

  describe("mkdocsPageRoute", () => {
    it("computes exact routes for directory-URL and flat-HTML modes", () => {
      expect(mkdocsPageRoute("index.md", true)).toBe("/");
      expect(mkdocsPageRoute("index.md", false)).toBe("/index.html");
      expect(mkdocsPageRoute("README.md", true)).toBe("/");
      expect(mkdocsPageRoute("guide/index.md", true)).toBe("/guide/");
      expect(mkdocsPageRoute("guide/index.md", false)).toBe("/guide.html");
      expect(mkdocsPageRoute("guide/setup.md", true)).toBe("/guide/setup/");
      expect(mkdocsPageRoute("guide/setup.md", false)).toBe("/guide/setup.html");
    });

    it("computes routes under a fully custom docs_dir-relative path", () => {
      expect(mkdocsPageRoute("nested/deep/page.md", true)).toBe("/nested/deep/page/");
      expect(mkdocsPageRoute("nested/deep/page.md", false)).toBe("/nested/deep/page.html");
    });

    it("rejects a non-.md page path", () => {
      expect(() => mkdocsPageRoute("guide/setup.rst", true)).toThrow(MkdocsConfigurationParseError);
    });
  });

  describe("scanMkdocsMaterialBlocks", () => {
    it("recognizes admonitions, details, and content tabs without throwing", () => {
      const source = [
        "# Features",
        "",
        '!!! note "Heads up"',
        "    Body text.",
        "",
        '??? warning "Optional"',
        "    Body text.",
        "",
        '=== "Tab A"',
        "    Body text.",
        "",
        '=== "Tab B"',
        "    Body text.",
        "",
      ].join("\n");
      expect(() => scanMkdocsMaterialBlocks(source)).not.toThrow();
    });

    it("does not misread a bare setext heading underline as a content tab", () => {
      expect(() => scanMkdocsMaterialBlocks("Title\n===\n")).not.toThrow();
    });

    it("rejects a marker misaligned to a 4-space indentation level", () => {
      const source = ['!!! note "Outer"', '  !!! warning "Misaligned inner"'].join("\n");
      expect(() => scanMkdocsMaterialBlocks(source)).toThrow(/4-space indentation/u);
    });

    it("rejects Material blocks nested beyond the supported depth", () => {
      const lines: string[] = [];
      for (let level = 0; level < 6; level += 1)
        lines.push(`${" ".repeat(level * 4)}!!! note "Level ${level}"`);
      expect(() => scanMkdocsMaterialBlocks(lines.join("\n"))).toThrow(
        /maximum supported nesting depth/u,
      );
    });
  });

  describe("end-to-end MkDocs source validation", () => {
    it("registers mkdocs with a supported validate capability", () => {
      expect(resolveDocumentationSourceAdapter("mkdocs").capabilities.validate).toBe("supported");
    });

    it("validates a custom docs_dir project with nested explicit nav and directory URLs", async () => {
      const root = await fixtureRoot();
      const changedPaths: ChangedEntry[] = [
        { path: "mkdocs.yml", status: "added" },
        { path: "docs/site/index.md", status: "added" },
        { path: "docs/site/guide/setup.md", status: "added" },
        { path: "docs/site/guide/advanced.md", status: "added" },
        { path: "docs/site/features.md", status: "added" },
        { path: "docs/site/reference/index.md", status: "added" },
      ];
      const applicability = await deriveDocumentationSourceApplicability(
        baseInput(root, changedPaths),
      );
      expect(applicability.roots[0]).toMatchObject({ adapterId: "mkdocs", limitations: [] });
      await expect(
        validateSourceAwareStructuralDocumentation(root, applicability.changedPaths, applicability),
      ).resolves.toEqual(PASSED_RESULTS);
    });

    it("rejects a dot-segment docs_dir instead of silently passing an orphan page", async () => {
      const root = await roots.create("docsfab-mkdocs-dotsegment-orphan-");
      await writeFile(
        join(root, "mkdocs.yml"),
        ["docs_dir: ./docs", "nav:", "  - Home: index.md"].join("\n") + "\n",
      );
      await mkdir(join(root, "docs"));
      await writeFile(join(root, "docs/index.md"), "# Home\n");
      await writeFile(join(root, "docs/orphan.md"), "# Orphan\n");
      const applicability = await deriveDocumentationSourceApplicability(
        baseInput(root, [
          { path: "mkdocs.yml", status: "added" },
          { path: "docs/orphan.md", status: "added" },
        ]),
      );
      await expect(
        validateSourceAwareStructuralDocumentation(root, applicability.changedPaths, applicability),
      ).rejects.toMatchObject({ check: "documentation-navigation-targets", status: "limitation" });
    });

    it("rejects a dot-segment docs_dir instead of silently passing a broken relative link", async () => {
      const root = await roots.create("docsfab-mkdocs-dotsegment-brokenlink-");
      await writeFile(
        join(root, "mkdocs.yml"),
        ["docs_dir: docs/.", "nav:", "  - Home: index.md"].join("\n") + "\n",
      );
      await mkdir(join(root, "docs"));
      await writeFile(join(root, "docs/index.md"), "[Broken](does-not-exist.md)\n");
      const applicability = await deriveDocumentationSourceApplicability(
        baseInput(root, [
          { path: "mkdocs.yml", status: "added" },
          { path: "docs/index.md", status: "added" },
        ]),
      );
      await expect(
        validateSourceAwareStructuralDocumentation(root, applicability.changedPaths, applicability),
      ).rejects.toMatchObject({ check: "documentation-navigation-targets", status: "limitation" });
    });

    it("fails a relevant broken nav route", async () => {
      const root = await fixtureRoot();
      const brokenNav = [
        "site_name: Example Docs",
        "docs_dir: docs/site",
        "nav:",
        "  - Home: index.md",
        "  - Reference: reference/missing.md",
      ].join("\n");
      await writeFile(join(root, "mkdocs.yml"), `${brokenNav}\n`);
      const applicability = await deriveDocumentationSourceApplicability(
        baseInput(root, [{ path: "mkdocs.yml", status: "modified" }]),
      );
      await expect(
        validateSourceAwareStructuralDocumentation(root, applicability.changedPaths, applicability),
      ).rejects.toMatchObject({ check: "documentation-navigation-targets", status: "failed" });
    });

    it("keeps an unrelated broken document outside the required closure", async () => {
      const root = await fixtureRoot();
      await writeFile(join(root, "docs/site/scratch.md"), "[Missing](does-not-exist.md)\n");
      const applicability = await deriveDocumentationSourceApplicability(
        baseInput(root, [{ path: "docs/site/index.md", status: "modified" }]),
      );
      await expect(
        validateSourceAwareStructuralDocumentation(root, applicability.changedPaths, applicability),
      ).resolves.toEqual(PASSED_RESULTS);
    });

    it("flags a new page that needs an explicit nav update", async () => {
      const root = await fixtureRoot();
      await writeFile(join(root, "docs/site/new-page.md"), "# New Page\n");
      const applicability = await deriveDocumentationSourceApplicability(
        baseInput(root, [{ path: "docs/site/new-page.md", status: "added" }]),
      );
      await expect(
        validateSourceAwareStructuralDocumentation(root, applicability.changedPaths, applicability),
      ).rejects.toMatchObject({ check: "documentation-navigation-targets", status: "limitation" });
    });

    it("passes a multi-page update with an authorized nav edit", async () => {
      const root = await fixtureRoot();
      await writeFile(join(root, "docs/site/new-page.md"), "# New Page\n");
      const updatedNav = [
        "site_name: Example Docs",
        "docs_dir: docs/site",
        "nav:",
        "  - Home: index.md",
        "  - User Guide:",
        "      - Setup: guide/setup.md",
        "      - Advanced: guide/advanced.md",
        "  - Features: features.md",
        "  - Reference: reference/index.md",
        "  - New Page: new-page.md",
      ].join("\n");
      await writeFile(join(root, "mkdocs.yml"), `${updatedNav}\n`);
      const applicability = await deriveDocumentationSourceApplicability(
        baseInput(root, [
          { path: "docs/site/new-page.md", status: "added" },
          { path: "mkdocs.yml", status: "modified" },
        ]),
      );
      await expect(
        validateSourceAwareStructuralDocumentation(root, applicability.changedPaths, applicability),
      ).resolves.toEqual(PASSED_RESULTS);
    });

    it("validates automatic navigation when nav is absent", async () => {
      const root = await roots.create("docsfab-mkdocs-automatic-");
      await writeFile(join(root, "mkdocs.yml"), "site_name: Automatic Example\n");
      await mkdir(join(root, "docs/guide"), { recursive: true });
      await writeFile(join(root, "docs/index.md"), "# Automatic Home\n");
      await writeFile(join(root, "docs/guide/topic.md"), "# Topic\n");
      const applicability = await deriveDocumentationSourceApplicability(
        baseInput(root, [
          { path: "mkdocs.yml", status: "added" },
          { path: "docs/index.md", status: "added" },
          { path: "docs/guide/topic.md", status: "added" },
        ]),
      );
      expect(applicability.roots[0]).toMatchObject({ adapterId: "mkdocs", limitations: [] });
      await expect(
        validateSourceAwareStructuralDocumentation(root, applicability.changedPaths, applicability),
      ).resolves.toEqual(PASSED_RESULTS);
    });

    it("rejects a Python-tagged nav configuration at the delivery seam", async () => {
      const root = await roots.create("docsfab-mkdocs-python-tag-");
      await writeFile(
        join(root, "mkdocs.yml"),
        "nav:\n  - Home: !!python/name:material.extensions.emoji.to_svg\n",
      );
      await mkdir(join(root, "docs"));
      await writeFile(join(root, "docs/index.md"), "# Home\n");
      const applicability = await deriveDocumentationSourceApplicability(
        baseInput(root, [{ path: "mkdocs.yml", status: "added" }]),
      );
      await expect(
        validateSourceAwareStructuralDocumentation(root, applicability.changedPaths, applicability),
      ).rejects.toMatchObject({ check: "documentation-navigation-targets", status: "limitation" });
    });

    it("rejects automatic navigation combined with configured plugins", async () => {
      const root = await roots.create("docsfab-mkdocs-plugins-");
      await writeFile(join(root, "mkdocs.yml"), "plugins:\n  - awesome-pages\n");
      await mkdir(join(root, "docs"));
      await writeFile(join(root, "docs/index.md"), "# Home\n");
      const applicability = await deriveDocumentationSourceApplicability(
        baseInput(root, [{ path: "mkdocs.yml", status: "added" }]),
      );
      await expect(
        validateSourceAwareStructuralDocumentation(root, applicability.changedPaths, applicability),
      ).rejects.toMatchObject({ check: "documentation-navigation-targets", status: "limitation" });
    });

    it("rejects an ambiguous mkdocs.yml/mkdocs.yaml configuration pair", async () => {
      // Deriving applicability with both mkdocs.yml and mkdocs.yaml present throws
      // upstream (documentation-source-applicability.ts) before reaching this
      // adapter, so this proves the MkDocs delivery guard rejects the ambiguous
      // pair when reached directly.
      const root = await fixtureRoot();
      await writeFile(join(root, "mkdocs.yaml"), "site_name: Duplicate\n");
      await expect(
        validateMkdocsStructuralDocumentation(
          root,
          [{ path: "mkdocs.yaml", status: "added" }],
          [{ path: "mkdocs.yml" }, { path: "mkdocs.yaml" }],
        ),
      ).rejects.toMatchObject({ check: "documentation-navigation-targets", status: "limitation" });
    });
  });
});
