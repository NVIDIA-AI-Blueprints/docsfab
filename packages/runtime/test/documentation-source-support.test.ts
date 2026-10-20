// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { DurableArtifactStore } from "../src/artifacts/store.js";
import {
  DocumentationSourceApplicabilityError,
  assertDocumentationSourceApplicability,
  deriveDocumentationSourceApplicability,
  loadDocumentationSourceApplicability,
  storeDocumentationSourceApplicability,
} from "../src/repository/documentation-source-applicability.js";
import * as documentationSourceSupport from "../src/repository/documentation-source-support.js";
import {
  DOCUMENTATION_SOURCE_ADAPTER_IDS,
  documentationMarkdownAnchors,
  isDocumentationSourceConfigurationPath,
  resolveDocumentationSourceAdapter,
} from "../src/repository/documentation-source-support.js";
import { validateSourceAwareStructuralDocumentation } from "../src/delivery/structural-documentation-validator.js";
import { completeDocumentationValidationResults } from "../src/delivery/worktree/validate.js";
import { temporaryRoots } from "./helpers/temp.js";

const roots = temporaryRoots();
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/**
 * Synthesize adapterId as reserved/unsupported for one test, independent of its
 * real registry status, so "reserved adapter" tests do not depend on which real
 * adapters are still unsupported.
 */
async function withSynthesizedUnsupportedAdapter(
  adapterId: string,
  limitationCode: string,
  run: () => Promise<void> | void,
): Promise<void> {
  const original = documentationSourceSupport.documentationSourceLimitationForAdapter;
  const spy = vi
    .spyOn(documentationSourceSupport, "documentationSourceLimitationForAdapter")
    .mockImplementation((id) => (id === adapterId ? limitationCode : original(id)) as never);
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
}

describe("documentation source support", () => {
  it("extracts native heading anchors outside literal examples", () => {
    expect(
      [
        ...documentationMarkdownAnchors(
          [
            "# Install `DocsFab`",
            "## A",
            "## A",
            "## A-1",
            '<a id="CustomAnchor"></a>',
            '<a name="LegacyName"></a>',
            '<a id = "WhitespaceAnchor"></a>',
            '<a data-id="SpoofedDataAnchor"></a>',
            `<a title='id="SpoofedValueAnchor"'></a>`,
            "```md",
            "# Fenced example",
            '<a id="FencedAnchor"></a>',
            "```",
            "    # Indented example",
            '    <a id="IndentedAnchor"></a>',
            "`multiline code",
            '<a id="InlineCodeAnchor"></a>',
            "`",
            "<!--",
            '<a id="CommentAnchor"></a>',
            "-->",
            "(myst-label)=",
            "",
          ].join("\n"),
        ),
      ].sort(),
    ).toEqual([
      "CustomAnchor",
      "LegacyName",
      "WhitespaceAnchor",
      "a",
      "a-1",
      "a-1-1",
      "install-docsfab",
    ]);
    expect(documentationMarkdownAnchors("Foo\nBar\n---\n")).toEqual(["foo-bar"]);
    expect(documentationMarkdownAnchors("[ref]: /url\nTitle\n---\n")).toEqual(["title"]);
    expect(documentationMarkdownAnchors("Lead\n[ref]: /url\n---\n")).toEqual(["lead-ref-url"]);
    expect(documentationMarkdownAnchors("\t# Ghost\n---\n")).toEqual([]);
    expect(documentationMarkdownAnchors("# Actual\n---\n")).toEqual(["actual"]);
    expect(documentationMarkdownAnchors("---\ntitle: Ghost\n---\n\nBody.\n")).toEqual([]);
    expect(documentationMarkdownAnchors("<a id={value}></a>\n")).toEqual([]);
    expect(documentationMarkdownAnchors('<a id="{value}"></a>\n')).toEqual(["{value}"]);
    expect(
      documentationMarkdownAnchors('<a id="actual" name="legacy" title="{literal}"></a>\n'),
    ).toEqual(["actual", "legacy"]);
    for (const source of [
      '<a {...props} id="actual"></a>\n',
      '<a id="actual" {...props}></a>\n',
      '<a id="actual" id={value}></a>\n',
      '<a id="actual" / {...props}></a>\n',
      '<a id="first" ID="ghost"></a>\n',
      '<a name="first" NAME="ghost"></a>\n',
    ])
      expect(documentationMarkdownAnchors(source)).toEqual([]);
    expect(documentationMarkdownAnchors('<a id="actual" />\n')).toEqual(["actual"]);
  });

  it("validates decoded heading, custom, and same-page anchors and rejects a missing anchor", async () => {
    const root = await roots.create("docsfab-plain-anchors-");
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(
      join(root, "README.md"),
      [
        "# Overview",
        "",
        "[Install](docs/guide.md#present-anchor)",
        "[Custom](docs/guide.md#Caf%C3%A9)",
        "[Legacy](docs/guide.md#LegacyName)",
        "[Overview](#overview)",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(root, "docs/guide.md"),
      '# Present anchor\n\n<a id="Café"></a>\n<a name="LegacyName"></a>\n',
    );
    const derive = () =>
      deriveDocumentationSourceApplicability({
        candidateRoot: root,
        repositoryIdentitySha256: digest("repository"),
        baseRevision: "a".repeat(40),
        candidateInputTreeSha256: digest("candidate"),
        changedPaths: [{ path: "README.md", status: "modified" }],
      });
    const positive = await derive();
    await expect(
      validateSourceAwareStructuralDocumentation(root, positive.changedPaths, positive),
    ).resolves.toHaveLength(4);

    for (const fragment of ["missing-anchor", "Present-anchor!"]) {
      await writeFile(join(root, "README.md"), `[Install](docs/guide.md#${fragment})\n`);
      const missing = await derive();
      await expect(
        validateSourceAwareStructuralDocumentation(root, missing.changedPaths, missing),
      ).rejects.toMatchObject({
        check: "documentation-relative-links",
        status: "failed",
      } satisfies Partial<StructuralDocumentationValidationError>);
    }

    for (const [source, fragment] of [
      ['<a id="actual" {...props}></a>\n', "actual"],
      ['<a id="actual" id={value}></a>\n', "actual"],
      ['<a id="actual" / {...props}></a>\n', "actual"],
      ['<a id="first" id="ghost"></a>\n', "first"],
    ]) {
      await writeFile(join(root, "README.md"), `[Install](docs/guide.md#${fragment})\n`);
      await writeFile(join(root, "docs/guide.md"), source);
      const invalidAnchor = await derive();
      await expect(
        validateSourceAwareStructuralDocumentation(root, invalidAnchor.changedPaths, invalidAnchor),
      ).rejects.toMatchObject({
        check: "documentation-relative-links",
        status: "failed",
      } satisfies Partial<StructuralDocumentationValidationError>);
    }

    await writeFile(join(root, "README.md"), "[Install](docs/guide.md#actual)\n");
    await writeFile(join(root, "docs/guide.md"), '<a id="actual" />\n');
    const selfClosingAnchor = await derive();
    await expect(
      validateSourceAwareStructuralDocumentation(
        root,
        selfClosingAnchor.changedPaths,
        selfClosingAnchor,
      ),
    ).resolves.toHaveLength(4);
  });

  it("reserves a fixed adapter registry and pins which adapters validate", () => {
    // Each validate state is pinned explicitly: the fixed id list is stable and
    // no implemented adapter silently regresses to "unsupported".
    expect(DOCUMENTATION_SOURCE_ADAPTER_IDS).toEqual([
      "plain-markdown",
      "mkdocs",
      "docusaurus",
      "sphinx",
      "fern",
      "jupyter-book",
    ]);
    const validate = (adapterId: (typeof DOCUMENTATION_SOURCE_ADAPTER_IDS)[number]) =>
      resolveDocumentationSourceAdapter(adapterId).capabilities.validate;
    expect(validate("plain-markdown")).toBe("supported");
    expect(validate("fern")).toBe("supported");
    expect(validate("mkdocs")).toBe("supported");
    expect(validate("docusaurus")).toBe("supported");
    expect(validate("sphinx")).toBe("supported");
    expect(validate("jupyter-book")).toBe("partial");
    expect(isDocumentationSourceConfigurationPath("fern/docs.yml")).toBe(true);
    expect(isDocumentationSourceConfigurationPath("packages/widget/fern/docs.yml")).toBe(true);
    expect(isDocumentationSourceConfigurationPath("docs/old.md")).toBe(false);
  });

  it("derives and validates positive root and nested plain no-navigation roots", async () => {
    const root = await roots.create("docsfab-plain-source-");
    await mkdir(join(root, "packages/widget/docs"), { recursive: true });
    await writeFile(join(root, "README.md"), "# Root\n\n[Widget](packages/widget/docs/guide.md)\n");
    await writeFile(join(root, "packages/widget/docs/guide.md"), "# Widget\n");
    const applicability = await deriveDocumentationSourceApplicability({
      candidateRoot: root,
      repositoryIdentitySha256: digest("repository"),
      baseRevision: "a".repeat(40),
      candidateInputTreeSha256: digest("candidate"),
      changedPaths: [
        { path: "README.md", status: "modified" },
        { path: "packages/widget/docs/guide.md", status: "added" },
      ],
    });
    expect(applicability.roots).toEqual([
      expect.objectContaining({ root: ".", adapterId: "plain-markdown", navigationMode: "none" }),
      expect.objectContaining({
        root: "packages/widget",
        adapterId: "plain-markdown",
        navigationMode: "none",
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
    const store = new DurableArtifactStore(join(root, ".artifacts"));
    await storeDocumentationSourceApplicability(store, applicability);
    await expect(
      loadDocumentationSourceApplicability(store, applicability.applicabilitySha256),
    ).resolves.toEqual(applicability);
  });

  it("separates a root Fern closure from a nested plain package root", async () => {
    const root = await roots.create("docsfab-separated-source-roots-");
    await mkdir(join(root, "fern"));
    await mkdir(join(root, "docs"));
    await mkdir(join(root, "packages/widget/docs"), { recursive: true });
    await writeFile(
      join(root, "fern/docs.yml"),
      "navigation:\n  - page: Root\n    path: ../docs/root.md\n",
    );
    await writeFile(join(root, "docs/root.md"), "# Root\n");
    await writeFile(join(root, "packages/widget/docs/guide.md"), "# Widget one\n");
    const input = {
      candidateRoot: root,
      repositoryIdentitySha256: digest("repository"),
      baseRevision: "a".repeat(40),
      candidateInputTreeSha256: digest("candidate"),
      changedPaths: [
        { path: "docs/root.md", status: "modified" as const },
        { path: "packages/widget/docs/guide.md", status: "modified" as const },
      ],
    };
    const first = await deriveDocumentationSourceApplicability(input);
    expect(first.roots).toEqual([
      expect.objectContaining({ root: ".", adapterId: "fern", limitations: [] }),
      expect.objectContaining({
        root: "packages/widget",
        adapterId: "plain-markdown",
        limitations: [],
      }),
    ]);
    await writeFile(join(root, "packages/widget/docs/guide.md"), "# Widget two\n");
    const second = await deriveDocumentationSourceApplicability(input);
    expect(second.roots[0]?.requiredPathClosureSha256).toBe(
      first.roots[0]?.requiredPathClosureSha256,
    );
    expect(second.roots[1]?.requiredPathClosureSha256).not.toBe(
      first.roots[1]?.requiredPathClosureSha256,
    );
  });

  it("binds unchanged Fern navigation target bytes into the required closure", async () => {
    const root = await roots.create("docsfab-fern-target-closure-");
    await mkdir(join(root, "fern"));
    await mkdir(join(root, "docs"));
    await writeFile(
      join(root, "fern/docs.yml"),
      "navigation:\n  - page: Guide\n    path: ../docs/guide.md\n",
    );
    await writeFile(join(root, "docs/guide.md"), "# Guide one\n");
    const input = {
      candidateRoot: root,
      repositoryIdentitySha256: digest("repository"),
      baseRevision: "a".repeat(40),
      candidateInputTreeSha256: digest("candidate"),
      changedPaths: [{ path: "fern/docs.yml", status: "modified" as const }],
    };
    const first = await deriveDocumentationSourceApplicability(input);
    await writeFile(join(root, "docs/guide.md"), "# Guide two\n");
    const second = await deriveDocumentationSourceApplicability(input);
    expect(second.roots[0]?.requiredPathClosureSha256).not.toBe(
      first.roots[0]?.requiredPathClosureSha256,
    );
  });

  it("binds referenced target bytes and missing markers while ignoring fenced examples", async () => {
    const root = await roots.create("docsfab-linked-target-closure-");
    await mkdir(join(root, "docs"));
    await writeFile(
      join(root, "README.md"),
      "[Target](docs/target.md)\n\n```md\n[Example](docs/example.md)\n```\n",
    );
    await writeFile(join(root, "docs/target.md"), "# Target one\n");
    await writeFile(join(root, "docs/example.md"), "# Example one\n");
    const input = {
      candidateRoot: root,
      repositoryIdentitySha256: digest("repository"),
      baseRevision: "a".repeat(40),
      candidateInputTreeSha256: digest("candidate"),
      changedPaths: [{ path: "README.md", status: "modified" as const }],
    };
    const first = await deriveDocumentationSourceApplicability(input);
    await writeFile(join(root, "docs/target.md"), "# Target two\n");
    const targetChanged = await deriveDocumentationSourceApplicability(input);
    expect(targetChanged.roots[0]?.requiredPathClosureSha256).not.toBe(
      first.roots[0]?.requiredPathClosureSha256,
    );
    await writeFile(join(root, "docs/example.md"), "# Example two\n");
    const fencedExampleChanged = await deriveDocumentationSourceApplicability(input);
    expect(fencedExampleChanged.roots[0]?.requiredPathClosureSha256).toBe(
      targetChanged.roots[0]?.requiredPathClosureSha256,
    );
    await rm(join(root, "docs/target.md"));
    const missing = await deriveDocumentationSourceApplicability(input);
    expect(missing.roots[0]?.requiredPathClosureSha256).not.toBe(
      fencedExampleChanged.roots[0]?.requiredPathClosureSha256,
    );
    await expect(
      validateSourceAwareStructuralDocumentation(root, input.changedPaths, missing),
    ).rejects.toMatchObject({ check: "documentation-relative-links", status: "failed" });
  });

  it("distinguishes multiline code spans from unmatched backtick runs", async () => {
    const root = await roots.create("docsfab-inline-code-links-");
    await writeFile(join(root, "README.md"), "`example\n[Inert](missing.md)`\n");
    const input = {
      candidateRoot: root,
      repositoryIdentitySha256: digest("repository"),
      baseRevision: "a".repeat(40),
      candidateInputTreeSha256: digest("candidate"),
      changedPaths: [{ path: "README.md", status: "modified" as const }],
    };
    const inert = await deriveDocumentationSourceApplicability(input);
    await expect(
      validateSourceAwareStructuralDocumentation(root, input.changedPaths, inert),
    ).resolves.toEqual(
      expect.arrayContaining([{ id: "documentation-relative-links", status: "passed" }]),
    );

    await writeFile(join(root, "README.md"), "`[Broken](missing.md)``\n");
    const live = await deriveDocumentationSourceApplicability(input);
    await expect(
      validateSourceAwareStructuralDocumentation(root, input.changedPaths, live),
    ).rejects.toMatchObject({ check: "documentation-relative-links", status: "failed" });
  });

  it("fails a synthesized reserved adapter and rejects closed-record substitution", async () => {
    await withSynthesizedUnsupportedAdapter("mkdocs", "unsupported-mkdocs-adapter", async () => {
      const root = await roots.create("docsfab-unsupported-source-");
      await writeFile(join(root, "mkdocs.yml"), "site_name: Example\n");
      await mkdir(join(root, "docs"));
      await writeFile(join(root, "docs/index.md"), "# Example\n");
      const applicability = await deriveDocumentationSourceApplicability({
        candidateRoot: root,
        repositoryIdentitySha256: digest("repository"),
        baseRevision: "a".repeat(40),
        candidateInputTreeSha256: digest("candidate"),
        changedPaths: [{ path: "docs/index.md", status: "modified" }],
      });
      expect(applicability.roots[0]).toMatchObject({
        adapterId: "mkdocs",
        limitations: ["unsupported-mkdocs-adapter"],
      });
      await expect(
        validateSourceAwareStructuralDocumentation(root, applicability.changedPaths, applicability),
      ).rejects.toMatchObject({
        status: "limitation",
        check: "documentation-source-applicability",
      });
      expect(() =>
        assertDocumentationSourceApplicability({
          ...applicability,
          candidateInputTreeSha256: digest("substituted"),
        }),
      ).toThrow(DocumentationSourceApplicabilityError);
      expect(() =>
        assertDocumentationSourceApplicability({ ...applicability, extra: true }),
      ).toThrow(DocumentationSourceApplicabilityError);
    });
  });

  it("keeps an unrelated broken document outside the required plain closure", async () => {
    const root = await roots.create("docsfab-unrelated-source-");
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "README.md"), "# Current\n");
    await writeFile(join(root, "docs/broken.md"), "[Missing](does-not-exist.md)\n");
    const applicability = await deriveDocumentationSourceApplicability({
      candidateRoot: root,
      repositoryIdentitySha256: digest("repository"),
      baseRevision: "a".repeat(40),
      candidateInputTreeSha256: digest("candidate"),
      changedPaths: [{ path: "README.md", status: "modified" }],
    });
    await expect(
      validateSourceAwareStructuralDocumentation(root, applicability.changedPaths, applicability),
    ).resolves.toEqual([
      { id: "documentation-source-applicability", status: "passed" },
      { id: "documentation-paths-readable", status: "passed" },
      { id: "documentation-relative-links", status: "passed" },
      { id: "documentation-navigation-targets", status: "passed" },
    ]);
  });

  it("rejects mixed plain and Fern ownership at one root", async () => {
    const root = await roots.create("docsfab-mixed-root-ownership-");
    await mkdir(join(root, "fern"));
    await writeFile(join(root, "README.md"), "# Root\n");
    await writeFile(join(root, "fern/docs.yml"), "navigation: []\n");
    const applicability = await deriveDocumentationSourceApplicability({
      candidateRoot: root,
      repositoryIdentitySha256: digest("repository"),
      baseRevision: "a".repeat(40),
      candidateInputTreeSha256: digest("candidate"),
      changedPaths: [{ path: "README.md", status: "modified" }],
    });
    expect(applicability.roots[0]).toMatchObject({
      root: ".",
      adapterId: "fern",
      limitations: ["mixed-root-ownership"],
    });
    await expect(
      validateSourceAwareStructuralDocumentation(root, applicability.changedPaths, applicability),
    ).rejects.toMatchObject({ status: "limitation", check: "documentation-source-applicability" });
  });

  it.each([
    {
      name: "root configuration-only change",
      config: "fern/docs.yml",
      page: undefined,
    },
    {
      name: "nested Fern configuration-only change",
      config: "packages/widget/fern/docs.yml",
      page: undefined,
    },
  ])("parses the governing configuration for a $name", async ({ config, page }) => {
    const root = await roots.create("docsfab-malformed-fern-root-");
    await mkdir(join(root, config, ".."), { recursive: true });
    await writeFile(join(root, config), "navigation: [\n");
    if (page) {
      await mkdir(join(root, page, ".."), { recursive: true });
      await writeFile(join(root, page), "# Guide\n");
    }
    const changedPaths = [
      ...(page ? [{ path: page, status: "modified" as const }] : []),
      { path: config, status: "modified" as const },
    ];
    const applicability = await deriveDocumentationSourceApplicability({
      candidateRoot: root,
      repositoryIdentitySha256: digest("repository"),
      baseRevision: "a".repeat(40),
      candidateInputTreeSha256: digest("candidate"),
      changedPaths,
    });
    expect(applicability.roots).toHaveLength(1);
    expect(applicability.roots[0]).toMatchObject({ adapterId: "fern", limitations: [] });
    await expect(
      validateSourceAwareStructuralDocumentation(root, applicability.changedPaths, applicability),
    ).rejects.toMatchObject({ status: "limitation", check: "fern-navigation-targets" });
  });

  it("emits an ambiguity limitation for competing root configurations", async () => {
    const root = await roots.create("docsfab-ambiguous-root-ownership-");
    await mkdir(join(root, "fern"));
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "fern/docs.yml"), "navigation: []\n");
    await writeFile(join(root, "mkdocs.yml"), "site_name: Example\n");
    await writeFile(join(root, "docs/index.md"), "# Example\n");
    const applicability = await deriveDocumentationSourceApplicability({
      candidateRoot: root,
      repositoryIdentitySha256: digest("repository"),
      baseRevision: "a".repeat(40),
      candidateInputTreeSha256: digest("candidate"),
      changedPaths: [{ path: "docs/index.md", status: "modified" }],
    });
    expect(applicability.roots[0]?.limitations).toEqual([
      "ambiguous-root-ownership",
      "unsupported-relevant-configuration",
    ]);
  });

  it("blocks config deletion from manufacturing no-navigation", async () => {
    const root = await roots.create("docsfab-config-deletion-");
    await writeFile(join(root, "README.md"), "# Current\n");
    const applicability = await deriveDocumentationSourceApplicability({
      candidateRoot: root,
      repositoryIdentitySha256: digest("repository"),
      baseRevision: "a".repeat(40),
      candidateInputTreeSha256: digest("candidate"),
      changedPaths: [
        { path: "README.md", status: "modified" },
        { path: "fern/docs.yml", status: "deleted" },
      ],
      baseConfigurationPaths: ["fern/docs.yml"],
    });
    expect(applicability.roots[0]).toMatchObject({
      adapterId: "plain-markdown",
      navigationMode: "none",
      limitations: ["configuration-deleted-without-authorized-root-change"],
    });
    await expect(
      validateSourceAwareStructuralDocumentation(root, applicability.changedPaths, applicability),
    ).rejects.toMatchObject({ status: "limitation", check: "documentation-source-applicability" });
  });

  it("does not treat an ordinary deleted document as a deleted configuration", async () => {
    const root = await roots.create("docsfab-document-deletion-");
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "docs/new.md"), "# New\n");
    const applicability = await deriveDocumentationSourceApplicability({
      candidateRoot: root,
      repositoryIdentitySha256: digest("repository"),
      baseRevision: "a".repeat(40),
      candidateInputTreeSha256: digest("candidate"),
      changedPaths: [
        { path: "docs/old.md", status: "deleted" },
        { path: "docs/new.md", status: "added" },
      ],
      baseConfigurationPaths: ["docs/old.md"],
    });
    expect(applicability.roots[0]?.limitations).toEqual([]);
  });

  it("binds changed config bytes and blocks a synthesized-unsupported nested root", async () => {
    await withSynthesizedUnsupportedAdapter("mkdocs", "unsupported-mkdocs-adapter", async () => {
      const root = await roots.create("docsfab-mixed-source-");
      await mkdir(join(root, "packages/widget/docs"), { recursive: true });
      await writeFile(join(root, "README.md"), "# Root\n");
      await writeFile(join(root, "packages/widget/mkdocs.yml"), "site_name: Widget\n");
      await writeFile(join(root, "packages/widget/docs/index.md"), "# Widget\n");
      const input = {
        candidateRoot: root,
        repositoryIdentitySha256: digest("repository"),
        baseRevision: "a".repeat(40),
        candidateInputTreeSha256: digest("candidate"),
        changedPaths: [
          { path: "README.md", status: "modified" as const },
          { path: "packages/widget/docs/index.md", status: "modified" as const },
          { path: "packages/widget/mkdocs.yml", status: "modified" as const },
        ],
      };
      const first = await deriveDocumentationSourceApplicability(input);
      expect(first.roots).toEqual([
        expect.objectContaining({ root: ".", adapterId: "plain-markdown", limitations: [] }),
        expect.objectContaining({
          root: "packages/widget",
          adapterId: "mkdocs",
          limitations: ["unsupported-mkdocs-adapter"],
        }),
      ]);
      await writeFile(join(root, "packages/widget/mkdocs.yml"), "site_name: Substituted\n");
      const substituted = await deriveDocumentationSourceApplicability(input);
      expect(substituted.applicabilitySha256).not.toBe(first.applicabilitySha256);
      expect(substituted.roots[1]?.configurationFiles[0]?.sha256).not.toBe(
        first.roots[1]?.configurationFiles[0]?.sha256,
      );
      await expect(
        validateSourceAwareStructuralDocumentation(root, first.changedPaths, first),
      ).rejects.toMatchObject({
        status: "limitation",
        check: "documentation-source-applicability",
      });
    });
  });

  it("rejects missing, extra, and duplicate validation results", () => {
    const expected = ["candidate-input-tree", "isolation-boundary"];
    expect(() =>
      completeDocumentationValidationResults(expected, [
        { id: "candidate-input-tree", status: "passed" },
      ]),
    ).toThrow(/validation-failed/u);
    expect(() =>
      completeDocumentationValidationResults(expected, [
        { id: "candidate-input-tree", status: "passed" },
        { id: "isolation-boundary", status: "passed" },
        { id: "unexpected", status: "passed" },
      ]),
    ).toThrow(/validation-failed/u);
    expect(() =>
      completeDocumentationValidationResults(expected, [
        { id: "candidate-input-tree", status: "passed" },
        { id: "candidate-input-tree", status: "passed" },
      ]),
    ).toThrow(/validation-failed/u);
  });
});
