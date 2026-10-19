// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  buildContentIndex,
  buildScopedContentIndex,
  canonicalJson,
  ContentIndexError,
  contentIndexLimitations,
  diffContentIndexes,
} from "../src/content-ir/index.js";
import type { ContentIndexV1, DocumentNode, SectionNode } from "../src/content-ir/index.js";

export interface registerContentIrScenariosInputs {
  readonly fixtures: string;
  readonly contentDigest: string;
  readonly indexDigest: string;
  readonly excludedText: readonly string[];
  readonly poisonRelativePath: string;
  readonly directiveHeading: string;
  readonly directiveAnchor: string;
  readonly standaloneAnchor: string;
  readonly changeHeading: string;
  readonly changeAnchor: string;
  readonly changeBody: string;
}

export function registerContentIrScenarios(inputs: registerContentIrScenariosInputs): void {
  const fixtures = inputs.fixtures;
  const REVISION_A = "a".repeat(40);
  const REVISION_B = "b".repeat(40);

  describe("Content IR", () => {
    it("builds byte-identical normalized Markdown-first indexes", async () => {
      const repositoryPath = resolve(fixtures, "corpus");
      const first = await buildContentIndex({ repositoryPath, repositoryRevision: REVISION_A });
      const second = await buildContentIndex({ repositoryPath, repositoryRevision: REVISION_A });

      expect(canonicalJson(first)).toBe(canonicalJson(second));
      expect(first.indexDigest).toBe(second.indexDigest);
      expect(first.repository.contentDigest).toBe(inputs.contentDigest);
      expect(first.indexDigest).toBe(inputs.indexDigest);
      expect(first.repository).toMatchObject({
        revision: REVISION_A,
        contentDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      });
      expect(first.evidence).toEqual({
        repositoryRevision: REVISION_A,
        contentDigest: first.repository.contentDigest,
        indexDigest: first.indexDigest,
        documentCount: 4,
        sectionCount: 9,
        edgeCount: first.edges.length,
      });

      const documents = documentMap(first);
      expect(documents.get("index.md")?.format).toBe("markdown");
      expect(documents.get("guide.md")?.format).toBe("gfm");
      expect(documents.get("myst.md")?.format).toBe("myst");
      expect(documents.get("component.mdx")?.format).toBe("mdx");
      expect(documents.get("index.md")?.frontmatter).toEqual([
        { name: "id", type: "string" },
        { name: "published", type: "boolean" },
        { name: "title", type: "string" },
        { name: "weight", type: "number" },
      ]);
      expect(documents.get("myst.md")?.directives).toEqual([
        { name: "note", line: 6 },
        { name: "note", line: 11 },
      ]);
      expect(documents.get("component.mdx")?.codeBlocks).toEqual([
        { language: "tsx", startLine: 9, endLine: 11 },
      ]);
      expect(documents.get("myst.md")?.anchors).toContain(inputs.directiveAnchor);
      expect(documents.get("myst.md")?.anchors).toContain(inputs.standaloneAnchor);

      const nextSteps = first.nodes.find(
        (node) =>
          node.kind === "section" && node.sourcePath === "index.md" && node.anchor === "next-steps",
      );
      const guideDetails = first.nodes.find(
        (node) =>
          node.kind === "section" && node.sourcePath === "guide.md" && node.anchor === "details",
      );
      expect(nextSteps).toBeDefined();
      expect(guideDetails).toBeDefined();
      expect(first.edges).toContainEqual({
        kind: "outbound-link",
        from: nextSteps!.id,
        to: guideDetails!.id,
      });
      expect(first.edges).toContainEqual({
        kind: "outbound-link",
        from: nextSteps!.id,
        to: documents.get("myst.md")!.id,
      });
      expect(first.edges).toContainEqual({
        kind: "navigation",
        from: documents.get("index.md")!.id,
        to: documents.get("myst.md")!.id,
      });
      expect(first.edges).toContainEqual({
        kind: "navigation",
        from: documents.get("myst.md")!.id,
        to: documents.get("guide.md")!.id,
      });

      const edgeKinds = new Set(first.edges.map((edge) => edge.kind));
      expect(edgeKinds).toEqual(
        new Set([
          "parent",
          "child",
          "previous-sibling",
          "next-sibling",
          "outbound-link",
          "backlink",
          "navigation",
        ]),
      );
      expect(first.nodes.every((node) => !node.sourcePath.startsWith("/"))).toBe(true);
      const serialized = canonicalJson(first);
      expect(serialized).not.toContain(repositoryPath);
      for (const marker of inputs.excludedText) expect(serialized).not.toContain(marker);
    });

    it("keeps existing node identities stable when an unrelated page is added", async () => {
      await withFixtureCopy("corpus", async (repositoryPath) => {
        const before = await buildContentIndex({ repositoryPath, repositoryRevision: REVISION_A });
        await writeFile(
          resolve(repositoryPath, "unrelated.md"),
          "# Unrelated\n\nNew page.\n",
          "utf8",
        );
        const after = await buildContentIndex({ repositoryPath, repositoryRevision: REVISION_B });
        const beforeIds = new Map(
          before.nodes.map((node) => [
            `${node.kind}:${node.sourcePath}:${node.kind === "section" ? node.anchor : ""}`,
            node.id,
          ]),
        );
        for (const node of after.nodes.filter(
          (candidate) => candidate.sourcePath !== "unrelated.md",
        )) {
          const key = `${node.kind}:${node.sourcePath}:${node.kind === "section" ? node.anchor : ""}`;
          expect(node.id).toBe(beforeIds.get(key));
        }
        expect(after.repository.contentDigest).not.toBe(before.repository.contentDigest);
        expect(after.indexDigest).not.toBe(before.indexDigest);
      });
    });

    it.each([
      ["body", "body", ["body"]],
      ["headings", "headings", ["headings", "graph"]],
      ["metadata", "metadata", ["metadata"]],
      ["navigation", "navigation", ["navigation"]],
      ["graph", "graph", ["graph"]],
    ] as const)("isolates %s changes", async (_label, mutation, expected) => {
      await withFixtureCopy("changes", async (repositoryPath) => {
        const before = await buildContentIndex({ repositoryPath, repositoryRevision: REVISION_A });
        await mutate(repositoryPath, mutation);
        const after = await buildContentIndex({ repositoryPath, repositoryRevision: REVISION_B });
        const diff = diffContentIndexes(before, after);
        const changed = diff.documents.find((document) => document.sourcePath === "index.md");
        expect(changed?.regions).toEqual(expected);
        expect(diff.regions).toEqual(expect.arrayContaining([...expected]));
        expect(diff.fromIndexDigest).toBe(before.indexDigest);
        expect(diff.toIndexDigest).toBe(after.indexDigest);
      });
    });

    it("detects heading text changes when an explicit anchor preserves the section ID", async () => {
      await withFixtureCopy("changes", async (repositoryPath) => {
        const before = await buildContentIndex({ repositoryPath, repositoryRevision: REVISION_A });
        const path = resolve(repositoryPath, "index.md");
        const contents = await readFile(path, "utf8");
        await writeFile(
          path,
          contents.replace(`# ${inputs.changeHeading}`, `# Renamed page {#${inputs.changeAnchor}}`),
          "utf8",
        );
        const after = await buildContentIndex({ repositoryPath, repositoryRevision: REVISION_B });
        const beforeSection = before.nodes.find(
          (node) =>
            node.kind === "section" &&
            node.sourcePath === "index.md" &&
            node.anchor === inputs.changeAnchor,
        );
        const afterSection = after.nodes.find(
          (node) =>
            node.kind === "section" &&
            node.sourcePath === "index.md" &&
            node.anchor === inputs.changeAnchor,
        );

        expect(afterSection?.id).toBe(beforeSection?.id);
        const diff = diffContentIndexes(before, after);
        expect(diff.documents).toHaveLength(1);
        expect(diff.documents[0]).toMatchObject({ sourcePath: "index.md", regions: ["headings"] });
      });
    });

    it("detects a pure source-path move even when every region digest is unchanged", async () => {
      await withFixtureCopy("changes", async (repositoryPath) => {
        const before = await buildContentIndex({ repositoryPath, repositoryRevision: REVISION_A });
        const document = before.nodes.find(
          (node) => node.kind === "document" && node.sourcePath === "index.md",
        );
        if (!document || document.kind !== "document") throw new Error("Missing fixture document.");
        const after = structuredClone(before);
        after.repository.revision = REVISION_B;
        after.evidence.repositoryRevision = REVISION_B;
        after.indexDigest = "f".repeat(64);
        after.evidence.indexDigest = after.indexDigest;
        const moved = after.nodes.find((node) => node.id === document.id);
        if (!moved) throw new Error("Missing moved fixture document.");
        moved.sourcePath = "moved/index.md";

        const diff = diffContentIndexes(before, after);

        expect(diff.documents).toEqual([
          {
            documentId: document.id,
            sourcePath: "moved/index.md",
            previousSourcePath: "index.md",
            regions: ["navigation", "graph"],
          },
        ]);
      });
    });

    it("detects heading text changes when a MyST label preserves the section ID", async () => {
      await withFixtureCopy("corpus", async (repositoryPath) => {
        const before = await buildContentIndex({ repositoryPath, repositoryRevision: REVISION_A });
        const path = resolve(repositoryPath, "myst.md");
        const contents = await readFile(path, "utf8");
        await writeFile(
          path,
          contents.replace(`## ${inputs.directiveHeading}`, "## Renamed directive section"),
          "utf8",
        );
        const after = await buildContentIndex({ repositoryPath, repositoryRevision: REVISION_B });
        const beforeSection = before.nodes.find(
          (node) =>
            node.kind === "section" &&
            node.sourcePath === "myst.md" &&
            node.anchor === inputs.directiveAnchor,
        );
        const afterSection = after.nodes.find(
          (node) =>
            node.kind === "section" &&
            node.sourcePath === "myst.md" &&
            node.anchor === inputs.directiveAnchor,
        );

        expect(afterSection?.id).toBe(beforeSection?.id);
        const diff = diffContentIndexes(before, after);
        expect(diff.documents).toHaveLength(1);
        expect(diff.documents[0]).toMatchObject({ sourcePath: "myst.md", regions: ["headings"] });
      });
    });

    it("retains unresolved internal targets as non-dereferenceable graph findings", async () => {
      const index = await buildContentIndex({
        repositoryPath: resolve(fixtures, "invalid", "broken"),
        repositoryRevision: REVISION_A,
      });
      expect(index.edges).toContainEqual(
        expect.objectContaining({
          kind: "outbound-link",
          to: expect.stringMatching(/^external:[a-f0-9]{64}$/u),
        }),
      );
    });

    it("fails explicitly for authored duplicate identities", async () => {
      await expect(
        buildContentIndex({
          repositoryPath: resolve(fixtures, "invalid", "duplicate-document"),
          repositoryRevision: REVISION_A,
        }),
      ).rejects.toMatchObject({ code: "duplicate-node-identity" });
      // A repeated anchor stops only a page the caller targets; elsewhere it is recorded.
      await expect(
        buildContentIndex({
          repositoryPath: resolve(fixtures, "invalid", "duplicate-myst-label"),
          repositoryRevision: REVISION_A,
          targetPaths: ["index.md"],
        }),
      ).rejects.toMatchObject({
        code: "duplicate-page-anchor",
        message: expect.stringContaining(
          "The MyST label at line 8 of index.md repeats the anchor defined at line 3.",
        ),
      });
      const untargeted = await buildContentIndex({
        repositoryPath: resolve(fixtures, "invalid", "duplicate-myst-label"),
        repositoryRevision: REVISION_A,
      });
      expect(contentIndexLimitations(untargeted)).toMatchObject([
        { path: "index.md", reason: "duplicate-page-anchor", line: 8 },
      ]);
      await expect(
        buildContentIndex({
          repositoryPath: resolve(fixtures, "corpus"),
          repositoryRevision: "HEAD",
        }),
      ).rejects.toBeInstanceOf(ContentIndexError);
    });

    it("disambiguates generated heading anchors while preserving structural hierarchy", async () => {
      const index = await buildContentIndex({
        repositoryPath: resolve(fixtures, "invalid", "duplicate-anchor"),
        repositoryRevision: REVISION_A,
      });
      const headings = index.nodes.filter(
        (node): node is SectionNode => node.kind === "section" && node.sourcePath === "index.md",
      );

      expect(
        headings
          .sort((left, right) => left.startLine - right.startLine)
          .map((heading) => heading.anchor),
      ).toEqual(["repeated-heading", "repeated-heading-1"]);
      expect(new Set(headings.map((heading) => heading.id)).size).toBe(2);
    });

    it("treats a matching HTML permalink id as the heading's existing anchor", async () => {
      await withTempMarkdown(
        '<a id="atlas-queue"></a>\n# Atlas Queue\n',
        async (repositoryPath) => {
          const index = await buildContentIndex({
            repositoryPath,
            repositoryRevision: REVISION_A,
          });
          const sections = index.nodes.filter(
            (node): node is SectionNode =>
              node.kind === "section" && node.sourcePath === "README.md",
          );
          expect(sections.map((section) => section.anchor)).toEqual(["atlas-queue"]);
          expect(documentMap(index).get("README.md")?.anchors).toEqual(["atlas-queue"]);
        },
      );
    });

    it("stops a target page when two HTML ids collide without a matching heading", async () => {
      await withTempMarkdown(
        '<a id="orphan-anchor"></a>\n\nBody.\n\n<a id="orphan-anchor"></a>\n',
        async (repositoryPath) => {
          const untargeted = await buildContentIndex({
            repositoryPath,
            repositoryRevision: REVISION_A,
          });
          expect(contentIndexLimitations(untargeted)).toMatchObject([
            { path: "README.md", reason: "duplicate-page-anchor", line: 5 },
          ]);
          await expect(
            buildContentIndex({
              repositoryPath,
              repositoryRevision: REVISION_A,
              targetPaths: ["README.md"],
            }),
          ).rejects.toMatchObject({
            code: "duplicate-page-anchor",
            message: expect.stringContaining(
              "The HTML id at line 5 of README.md repeats the anchor defined at line 1.",
            ),
          });
        },
      );
    });

    it("stops a target page for an empty HTML id", async () => {
      await withTempMarkdown('<a id=" "></a>\n# Heading\n', async (repositoryPath) => {
        const untargeted = await buildContentIndex({
          repositoryPath,
          repositoryRevision: REVISION_A,
        });
        expect(contentIndexLimitations(untargeted)).toMatchObject([
          { path: "README.md", reason: "empty-page-anchor", line: 1 },
        ]);
        await expect(
          buildContentIndex({
            repositoryPath,
            repositoryRevision: REVISION_A,
            targetPaths: ["README.md"],
          }),
        ).rejects.toMatchObject({
          code: "empty-page-anchor",
          message: expect.stringContaining(
            "The HTML id at line 1 of README.md has no letter or digit to form an anchor.",
          ),
        });
      });
    });

    it("still registers HTML ids that are not heading aliases", async () => {
      await withTempMarkdown(
        '<a id="before-you-begin"></a>\n## Prerequisites\n',
        async (repositoryPath) => {
          const index = await buildContentIndex({
            repositoryPath,
            repositoryRevision: REVISION_A,
          });
          expect(documentMap(index).get("README.md")?.anchors).toEqual([
            "before-you-begin",
            "prerequisites",
          ]);
        },
      );
    });

    it("indexes existing non-document files and directories as opaque link targets", async () => {
      const repositoryPath = await mkdtemp(resolve(tmpdir(), "docsfab-content-ir-opaque-targets-"));
      try {
        await mkdir(resolve(repositoryPath, "evaluation", "dataset"), { recursive: true });
        await mkdir(resolve(repositoryPath, "skills", "example"), { recursive: true });
        await writeFile(
          resolve(repositoryPath, "README.md"),
          "# Index\n\n[Dataset](evaluation/dataset/data.json)\n\n[Skills](skills/example/)\n",
          "utf8",
        );
        await writeFile(
          resolve(repositoryPath, "evaluation", "dataset", "data.json"),
          "{}\n",
          "utf8",
        );
        await writeFile(
          resolve(repositoryPath, "skills", "example", "SKILL.md"),
          "# Skill\n",
          "utf8",
        );

        const index = await buildContentIndex({ repositoryPath, repositoryRevision: REVISION_A });
        const opaqueLinks = index.edges.filter(
          (edge) => edge.kind === "outbound-link" && edge.to.startsWith("external:"),
        );
        expect(opaqueLinks).toHaveLength(2);
        expect(new Set(opaqueLinks.map((edge) => edge.to)).size).toBe(2);
      } finally {
        await rm(repositoryPath, { recursive: true, force: true });
      }
    });

    it("excludes only repository-level fixture and governed-input roots", async () => {
      const repositoryPath = await mkdtemp(resolve(tmpdir(), "docsfab-content-ir-evaluation-"));
      try {
        for (const root of ["evaluation", "governed-assets", "skills"]) {
          await mkdir(resolve(repositoryPath, root, "invalid"), { recursive: true });
          await writeFile(
            resolve(repositoryPath, root, "invalid", "duplicate.md"),
            "# Duplicate\n\n# Duplicate\n",
            "utf8",
          );
        }
        await mkdir(resolve(repositoryPath, "docs", "evaluation"), { recursive: true });
        await writeFile(resolve(repositoryPath, "README.md"), "# Product\n", "utf8");
        await writeFile(
          resolve(repositoryPath, "docs", "evaluation", "guide.md"),
          "# Evaluation guide\n",
          "utf8",
        );

        const indexed = await buildContentIndex({
          repositoryPath,
          repositoryRevision: REVISION_A,
        });
        const paths = indexed.nodes
          .filter((node) => node.kind === "document")
          .map((node) => node.sourcePath);

        expect(paths.sort()).toEqual(["README.md", "docs/evaluation/guide.md"].sort());
        const directlyIndexed = await buildContentIndex({
          repositoryPath: resolve(repositoryPath, "evaluation", "invalid"),
          repositoryRevision: REVISION_A,
        });
        expect(directlyIndexed.evidence.documentCount).toBe(1);
        expect(
          directlyIndexed.nodes
            .filter((node) => node.kind === "section")
            .map((node) => node.anchor)
            .sort(),
        ).toEqual(["duplicate", "duplicate-1"]);
      } finally {
        await rm(repositoryPath, { recursive: true, force: true });
      }
    });

    it("bounds compilation to includePaths without walking unrelated sibling trees", async () => {
      const repositoryPath = await mkdtemp(resolve(tmpdir(), "docsfab-content-ir-bound-"));
      try {
        await mkdir(resolve(repositoryPath, "docs"), { recursive: true });
        await mkdir(resolve(repositoryPath, "unrelated"), { recursive: true });
        await writeFile(resolve(repositoryPath, "README.md"), "# Product\n", "utf8");
        await writeFile(resolve(repositoryPath, "usage.md"), "# Usage\n", "utf8");
        await writeFile(resolve(repositoryPath, "docs", "guide.md"), "# Guide\n", "utf8");
        await writeFile(resolve(repositoryPath, "unrelated", "huge.md"), "# Huge\n", "utf8");
        await symlink("README.md", resolve(repositoryPath, "unrelated", "trap-link"));

        const bounded = await buildContentIndex({
          repositoryPath,
          repositoryRevision: REVISION_A,
          includePaths: ["README.md"],
        });
        expect(
          bounded.nodes
            .filter((node) => node.kind === "document")
            .map((node) => node.sourcePath)
            .sort(),
        ).toEqual(["README.md", "usage.md"]);

        const nested = await buildContentIndex({
          repositoryPath,
          repositoryRevision: REVISION_A,
          includePaths: ["docs/guide.md"],
        });
        expect(
          nested.nodes
            .filter((node) => node.kind === "document")
            .map((node) => node.sourcePath)
            .sort(),
        ).toEqual(["README.md", "docs/guide.md", "usage.md"].sort());

        await expect(
          buildContentIndex({
            repositoryPath,
            repositoryRevision: REVISION_A,
            includePaths: ["../outside.md"],
          }),
        ).rejects.toMatchObject({ code: "unsafe-path" });
      } finally {
        await rm(repositoryPath, { recursive: true, force: true });
      }
    });

    it("indexes docs while nested invalid evaluation fixtures stay unwalked", async () => {
      const repositoryPath = await mkdtemp(resolve(tmpdir(), "docsfab-content-ir-nested-invalid-"));
      try {
        const poison = resolve(repositoryPath, inputs.poisonRelativePath);
        await mkdir(resolve(repositoryPath, "docs"), { recursive: true });
        await mkdir(poison, { recursive: true });
        await writeFile(resolve(repositoryPath, "docs", "page.md"), "# Page\n", "utf8");
        await cp(resolve(fixtures, "invalid/duplicate-myst-label"), poison, { recursive: true });

        const unbounded = await buildContentIndex({
          repositoryPath,
          repositoryRevision: REVISION_A,
        });
        expect(
          unbounded.nodes.filter((node) => node.kind === "document").map((node) => node.sourcePath),
        ).toEqual(["docs/page.md"]);

        const bounded = await buildContentIndex({
          repositoryPath,
          repositoryRevision: REVISION_A,
          includePaths: ["docs"],
        });
        expect(
          bounded.nodes.filter((node) => node.kind === "document").map((node) => node.sourcePath),
        ).toEqual(["docs/page.md"]);
      } finally {
        await rm(repositoryPath, { recursive: true, force: true });
      }
    });
  });

  function documentMap(index: ContentIndexV1): Map<string, DocumentNode> {
    return new Map(
      index.nodes
        .filter((node): node is DocumentNode => node.kind === "document")
        .map((node) => [node.sourcePath, node]),
    );
  }

  async function withFixtureCopy(
    name: string,
    operation: (repositoryPath: string) => Promise<void>,
  ): Promise<void> {
    const temporary = await mkdtemp(resolve(tmpdir(), "docsfab-content-ir-"));
    const repositoryPath = resolve(temporary, "repository");
    try {
      await cp(resolve(fixtures, name), repositoryPath, { recursive: true });
      await operation(repositoryPath);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  async function withTempMarkdown(
    contents: string,
    operation: (repositoryPath: string) => Promise<void>,
  ): Promise<void> {
    const repositoryPath = await mkdtemp(resolve(tmpdir(), "docsfab-content-ir-html-anchor-"));
    try {
      await writeFile(resolve(repositoryPath, "README.md"), contents, "utf8");
      await operation(repositoryPath);
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  }

  async function mutate(
    repositoryPath: string,
    mutation: "body" | "headings" | "metadata" | "navigation" | "graph",
  ): Promise<void> {
    if (mutation === "navigation") {
      await writeFile(
        resolve(repositoryPath, "mkdocs.yml"),
        "nav:\n  - Target: target.md\n  - Change: index.md\n",
        "utf8",
      );
      return;
    }
    const path = resolve(repositoryPath, "index.md");
    let contents = await readFile(path, "utf8");
    switch (mutation) {
      case "body":
        contents = contents.replace(inputs.changeBody, "Changed example body.");
        break;
      case "headings":
        contents = contents.replace(`# ${inputs.changeHeading}`, "# Renamed page");
        break;
      case "metadata":
        contents = contents.replace("audience: developer", "audience: operator");
        break;
      case "graph":
        contents = contents.replace("(target.md)", "(target.md#details)");
        break;
    }
    await writeFile(path, contents, "utf8");
  }

  /**
   * Focused scope. Symlinks on a real filesystem are the hosted-checkout shape;
   * the local export is covered through `prepareRepositoryWorkspace` in
   * `context-preflight.test.ts`.
   */
  describe("Focused Content IR scope (#883)", () => {
    async function repository(files: Record<string, string>): Promise<string> {
      const root = await mkdtemp(resolve(tmpdir(), "docsfab-content-ir-scope-"));
      for (const [path, contents] of Object.entries(files)) {
        await mkdir(dirname(resolve(root, path)), { recursive: true });
        await writeFile(resolve(root, path), contents, "utf8");
      }
      return root;
    }

    function documentPaths(index: ContentIndexV1): string[] {
      return index.nodes
        .filter((node): node is DocumentNode => node.kind === "document")
        .map((node) => node.sourcePath)
        .sort();
    }

    it("indexes two selected pages in different directories without walking sibling trees", async () => {
      const root = await repository({
        "README.md": "# Product\n",
        "docs/setup/install.md": "# Install\n",
        "docs/setup/upgrade.md": "# Upgrade\n",
        "guides/api/auth.md": "# Auth\n",
        "unrelated/huge.md": "# Huge\n",
      });
      try {
        await symlink("../README.md", resolve(root, "unrelated", "trap-link"));
        const result = await buildScopedContentIndex({
          repositoryPath: root,
          repositoryRevision: REVISION_A,
          includePaths: ["docs/setup/install.md", "guides/api/auth.md"],
        });
        expect(result.status).toBe("indexed");
        if (result.status !== "indexed") return;
        expect(documentPaths(result.index)).toEqual([
          "README.md",
          "docs/setup/install.md",
          "docs/setup/upgrade.md",
          "guides/api/auth.md",
        ]);
        expect(result.coverage).toEqual({
          refusedAliasPaths: [],
          incompleteNavigationPaths: [],
          skippedOptionalAliasPaths: [],
          outOfScopeNavigationTargets: 0,
          aliasNavigationTargets: 0,
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("skips an optional sibling alias and a non-source alias, while untargeted indexing admits both as in-repository aliases", async () => {
      const root = await repository({
        "AGENTS.md": "# Agents\n",
        "docs/x.md": "# X\n",
        ".envrc.real": "export A=1\n",
      });
      try {
        await symlink("AGENTS.md", resolve(root, "CLAUDE.md"));
        await symlink(".envrc.real", resolve(root, ".envrc"));
        const focused = await buildScopedContentIndex({
          repositoryPath: root,
          repositoryRevision: REVISION_A,
          includePaths: ["docs/x.md"],
        });
        expect(focused).toMatchObject({
          status: "indexed",
          coverage: {
            refusedAliasPaths: [],
            incompleteNavigationPaths: [],
            skippedOptionalAliasPaths: ["CLAUDE.md"],
          },
        });
        if (focused.status !== "indexed") return;
        expect(documentPaths(focused.index)).toEqual(["AGENTS.md", "docs/x.md"]);

        // No focused scope: both symlinks stay inside the repository, so they are
        // admitted as aliases, never read as pages, and nothing is recorded.
        for (const includePaths of [undefined, ["docs/x.md"]]) {
          const untargeted = await buildContentIndex({
            repositoryPath: root,
            repositoryRevision: REVISION_A,
            ...(includePaths ? { includePaths } : {}),
          });
          expect(contentIndexLimitations(untargeted)).toEqual([]);
          expect(documentPaths(untargeted)).not.toContain("CLAUDE.md");
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("reports a required navigation alias and an executable navigation file as incomplete", async () => {
      const root = await repository({
        "docs/guide/x.md": "# X\n",
        "versioned/sidebars.json": '["guide/x"]\n',
        "sidebars.js": "module.exports = {};\n",
      });
      try {
        await symlink("../versioned/sidebars.json", resolve(root, "docs", "sidebars.json"));
        const result = await buildScopedContentIndex({
          repositoryPath: root,
          repositoryRevision: REVISION_A,
          includePaths: ["docs/guide/x.md"],
        });
        expect(result).toMatchObject({
          status: "indexed",
          coverage: {
            refusedAliasPaths: [],
            incompleteNavigationPaths: ["docs/sidebars.json", "sidebars.js"],
            skippedOptionalAliasPaths: [],
          },
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("records executable navigation as unknown navigation when no focused scope is set", async () => {
      const root = await repository({
        "docs/x.md": "# X\n",
        "sidebars.js": "module.exports = {};\n",
      });
      try {
        const index = await buildContentIndex({
          repositoryPath: root,
          repositoryRevision: REVISION_A,
        });
        expect(contentIndexLimitations(index)).toEqual([
          { path: "sidebars.js", reason: "unsupported-navigation" },
        ]);
        expect(index.edges.filter((edge) => edge.kind === "navigation")).toEqual([]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("refuses a selected page alias and a symlinked directory on a target's path before reading", async () => {
      const root = await repository({ "content/x.md": "# X\n", "real/y.md": "# Y\n" });
      try {
        await symlink("../real/y.md", resolve(root, "content", "y.md"));
        await symlink("content", resolve(root, "docs"));
        const page = await buildScopedContentIndex({
          repositoryPath: root,
          repositoryRevision: REVISION_A,
          includePaths: ["content/y.md"],
        });
        expect(page).toEqual({
          status: "alias-refused",
          coverage: {
            refusedAliasPaths: ["content/y.md"],
            incompleteNavigationPaths: [],
            skippedOptionalAliasPaths: [],
            outOfScopeNavigationTargets: 0,
            aliasNavigationTargets: 0,
          },
        });
        const directory = await buildScopedContentIndex({
          repositoryPath: root,
          repositoryRevision: REVISION_A,
          includePaths: ["docs/x.md"],
        });
        expect(directory).toMatchObject({
          status: "alias-refused",
          coverage: { refusedAliasPaths: ["docs"] },
        });
        // A directory alias beside, not on, the target's path is not selected and
        // is never followed or refused.
        const beside = await buildScopedContentIndex({
          repositoryPath: root,
          repositoryRevision: REVISION_A,
          includePaths: ["content/x.md"],
        });
        expect(beside).toMatchObject({
          status: "indexed",
          coverage: { refusedAliasPaths: [], skippedOptionalAliasPaths: ["content/y.md"] },
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("counts root navigation entries outside the include set instead of throwing, and never bridges them", async () => {
      const root = await repository({
        // MkDocs resolves nav entries against docs_dir, which defaults to docs.
        "mkdocs.yml": [
          "nav:",
          "  - a/one.md",
          "  - other/far.md",
          "  - a/two.md",
          "  - a/three.md",
          "",
        ].join("\n"),
        "docs/a/one.md": "# One\n",
        "docs/a/two.md": "# Two\n",
        "docs/a/three.md": "# Three\n",
        "docs/other/far.md": "# Far\n",
      });
      try {
        // The focused build indexes instead of throwing broken-internal-target.
        const result = await buildScopedContentIndex({
          repositoryPath: root,
          repositoryRevision: REVISION_A,
          includePaths: ["docs/a/one.md"],
        });
        expect(result.status).toBe("indexed");
        if (result.status !== "indexed") return;
        expect(result.coverage.outOfScopeNavigationTargets).toBe(1);
        const ids = new Map(
          result.index.nodes
            .filter((node): node is DocumentNode => node.kind === "document")
            .map((node) => [node.sourcePath, node.id]),
        );
        const navigationEdges = result.index.edges
          .filter((edge) => edge.kind === "navigation")
          .map((edge) => [edge.from, edge.to]);
        expect(navigationEdges).toEqual([[ids.get("docs/a/two.md"), ids.get("docs/a/three.md")]]);

        // An in-scope entry that resolves to nothing is recorded by name, not a stop.
        await writeFile(
          resolve(root, "mkdocs.yml"),
          "nav:\n  - a/one.md\n  - a/missing.md\n",
          "utf8",
        );
        const recorded = await buildScopedContentIndex({
          repositoryPath: root,
          repositoryRevision: REVISION_A,
          includePaths: ["docs/a/one.md"],
        });
        if (recorded.status !== "indexed") throw new Error("Expected an indexed result.");
        expect(contentIndexLimitations(recorded.index)).toEqual([
          {
            path: "mkdocs.yml",
            reason: "page-not-indexed",
            entry: "a/missing.md",
            resolvedPath: "docs/a/missing.md",
          },
        ]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("breaks the chain at a skipped sibling alias that root navigation lists, on disk and as a tracked alias", async () => {
      const files = {
        "_toc.yml": [
          "root: intro",
          "- file: latest",
          "- file: guide/a",
          "- file: guide/b",
          "",
        ].join("\n"),
        "intro.md": "# Intro\n",
        "v2.md": "# V2\n",
        "guide/a.md": "# A\n",
        "guide/b.md": "# B\n",
      };
      const onDisk = await repository(files);
      const exported = await repository(files);
      const regular = await repository({ ...files, "latest.md": "# Latest\n" });
      try {
        await symlink("v2.md", resolve(onDisk, "latest.md"));
        for (const result of [
          await buildScopedContentIndex({
            repositoryPath: onDisk,
            repositoryRevision: REVISION_A,
            includePaths: ["guide/a.md", "guide/b.md"],
          }),
          // The materialized export leaves `latest.md` absent on disk.
          await buildScopedContentIndex({
            repositoryPath: exported,
            repositoryRevision: REVISION_A,
            includePaths: ["guide/a.md", "guide/b.md"],
            trackedAliasPaths: ["latest.md"],
          }),
        ]) {
          expect(result.status).toBe("indexed");
          if (result.status !== "indexed") return;
          expect(result.coverage).toEqual({
            refusedAliasPaths: [],
            incompleteNavigationPaths: [],
            skippedOptionalAliasPaths: ["latest.md"],
            outOfScopeNavigationTargets: 0,
            aliasNavigationTargets: 1,
          });
          const ids = new Map(
            result.index.nodes
              .filter((node): node is DocumentNode => node.kind === "document")
              .map((node) => [node.sourcePath, node.id]),
          );
          const navigationEdges = result.index.edges
            .filter((edge) => edge.kind === "navigation")
            .map((edge) => [edge.from, edge.to]);
          // intro -> latest -> a is broken at the alias; a -> b stays.
          expect(navigationEdges).toEqual([[ids.get("guide/a.md"), ids.get("guide/b.md")]]);
        }
        // A regular sibling page at the same path is not an alias; it bridges the chain.
        const plain = await buildScopedContentIndex({
          repositoryPath: regular,
          repositoryRevision: REVISION_A,
          includePaths: ["guide/a.md", "guide/b.md"],
        });
        expect(plain).toMatchObject({
          status: "indexed",
          coverage: { skippedOptionalAliasPaths: [], aliasNavigationTargets: 0 },
        });
        if (plain.status !== "indexed") return;
        expect(plain.index.edges.filter((edge) => edge.kind === "navigation")).toHaveLength(3);
      } finally {
        await rm(onDisk, { recursive: true, force: true });
        await rm(exported, { recursive: true, force: true });
        await rm(regular, { recursive: true, force: true });
      }
    });

    it("records an extensionless in-scope missing navigation entry and counts an extensionless out-of-scope one", async () => {
      const root = await repository({
        "_toc.yml": [
          "root: intro",
          "- file: guide/a",
          "- file: far/away",
          "- file: guide/b",
          "",
        ].join("\n"),
        "intro.md": "# Intro\n",
        "guide/a.md": "# A\n",
        "guide/b.md": "# B\n",
        "far/away.md": "# Away\n",
      });
      try {
        const counted = await buildScopedContentIndex({
          repositoryPath: root,
          repositoryRevision: REVISION_A,
          includePaths: ["guide/a.md", "guide/b.md"],
        });
        expect(counted).toMatchObject({
          status: "indexed",
          coverage: { outOfScopeNavigationTargets: 1, aliasNavigationTargets: 0 },
        });
        // `missing` at the root has candidates the focused walk would read, so it
        // is an in-scope entry the index cannot link: recorded by name, not a stop.
        await writeFile(
          resolve(root, "_toc.yml"),
          ["root: intro", "- file: missing", "- file: guide/a", ""].join("\n"),
          "utf8",
        );
        const recorded = await buildScopedContentIndex({
          repositoryPath: root,
          repositoryRevision: REVISION_A,
          includePaths: ["guide/a.md", "guide/b.md"],
        });
        expect(recorded).toMatchObject({
          status: "indexed",
          coverage: { outOfScopeNavigationTargets: 0, aliasNavigationTargets: 0 },
        });
        if (recorded.status !== "indexed") throw new Error("Expected an indexed result.");
        expect(contentIndexLimitations(recorded.index)).toEqual([
          {
            path: "_toc.yml",
            reason: "page-not-indexed",
            entry: "missing",
            resolvedPath: "missing",
          },
        ]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("refuses an alias inside a directory target, but not an excluded directory name there", async () => {
      const root = await repository({ "docs/guide/x.md": "# X\n", "real/old.md": "# Old\n" });
      try {
        await symlink("../../real/old.md", resolve(root, "docs", "guide", "old.md"));
        await symlink("../../real", resolve(root, "docs", "guide", "node_modules"));
        const result = await buildScopedContentIndex({
          repositoryPath: root,
          repositoryRevision: REVISION_A,
          includePaths: ["docs/guide"],
        });
        // Every entry of a directory target is selected, so the page alias is
        // refused; the excluded `node_modules` alias is never selected.
        expect(result).toEqual({
          status: "alias-refused",
          coverage: {
            refusedAliasPaths: ["docs/guide/old.md"],
            incompleteNavigationPaths: [],
            skippedOptionalAliasPaths: [],
            outOfScopeNavigationTargets: 0,
            aliasNavigationTargets: 0,
          },
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("classifies tracked aliases a materialized export leaves absent on disk", async () => {
      const root = await repository({ "docs/guide/x.md": "# X\n", "docs/guide/y.md": "# Y\n" });
      try {
        const result = await buildScopedContentIndex({
          repositoryPath: root,
          repositoryRevision: REVISION_A,
          includePaths: ["docs/guide/x.md"],
          trackedAliasPaths: ["docs/sidebars.json", "docs/guide/old.md", "unrelated/sidebars.json"],
        });
        expect(result).toMatchObject({
          status: "indexed",
          coverage: {
            refusedAliasPaths: [],
            incompleteNavigationPaths: ["docs/sidebars.json"],
            skippedOptionalAliasPaths: ["docs/guide/old.md"],
          },
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });
}
