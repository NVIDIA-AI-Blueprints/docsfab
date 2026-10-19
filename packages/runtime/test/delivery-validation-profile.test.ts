// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { validationBackendPolicySha256 } from "../src/delivery/worktree/validation-backend.js";
import type { AgentHarness, HarnessStepInput } from "../src/execution/contracts.js";
import type { RunRecord, RunStore } from "../src/records/contracts.js";
import {
  DOCUMENTATION_VALIDATION_BINDING_KIND,
  DOCUMENTATION_VALIDATION_ENTRYPOINT_COMMAND,
  DOCUMENTATION_VALIDATION_PROFILE_IDS,
  DOCUMENTATION_VALIDATION_PROFILE_VERSION,
  DOCUMENTATION_VALIDATION_PROFILE_VERSION_V2,
  DocumentationValidationError,
  assertDocumentationValidationBinding,
  documentationValidationSelectorInputSha256,
  resolveHostDocumentationValidator,
  selectDocumentationValidationProfile,
} from "../src/delivery/validation-profile.js";
import { OFFLINE_PRODUCT_TEST_STEPS } from "../src/product-test.js";
import {
  StructuralDocumentationValidationError,
  validateStructuralDocumentation,
} from "../src/delivery/structural-documentation-validator.js";
import { WorkflowRunner } from "../src/workflow-execution/runner.js";
import { readyContextPreflight } from "./helpers.js";
import { temporaryRoots } from "./helpers/temp.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const POLICY = validationBackendPolicySha256();
const serializedAttack = {
  plan: {
    validationProfile: "npm-check",
    validationCommand: "npm run check",
    documentationValidation: { profileId: "forged" },
  },
  config: { validationCommand: "npm run check", profile: "repo-owned" },
  environment: {
    DOCSFAB_VALIDATION_PROFILE: "npm-check",
    DOCSFAB_VALIDATION_COMMAND: "true",
  },
  modelOutput: { profileId: "docsfab-publication-validation", command: "true" },
  repositoryConfig: {
    validationCommand: "npm run check",
    scripts: { check: "npm run lint" },
  },
  patchText: 'diff --git a/.docsfab.json b/.docsfab.json\n+{"validationCommand":"true"}\n',
  scriptPresence: ["package.json", "validate.cjs", "node_modules/.bin/check"],
};

const temporaryDirectories = temporaryRoots();

describe("documentation validation profiles", () => {
  it("selects a versioned built-in profile from workflow, exact paths, and host policy", () => {
    const markdown = selectDocumentationValidationProfile({
      workflow: "update-documentation",
      changedPaths: ["README.md", "docs/guide.md"],
      hostPolicySha256: POLICY,
    });
    expect(markdown.binding.kind).toBe(DOCUMENTATION_VALIDATION_BINDING_KIND);
    expect(markdown.binding.profileId).toBe("docsfab-documentation-validation");
    expect(markdown.binding.profileVersion).toBe(DOCUMENTATION_VALIDATION_PROFILE_VERSION);
    expect(markdown.binding.checkIds).toEqual([
      "candidate-input-tree",
      "documentation-paths-readable",
      "documentation-relative-links",
      "fern-navigation-targets",
      "isolation-boundary",
    ]);
    expect(markdown.entrypointCommand).toBe(DOCUMENTATION_VALIDATION_ENTRYPOINT_COMMAND);
    expect(markdown.entrypointCommand).not.toBe("true");
    expect(markdown.entrypointCommand).not.toBe("npm run check");

    const mixed = selectDocumentationValidationProfile({
      workflow: "review-documentation",
      changedPaths: ["package.json", "src/index.ts"],
      hostPolicySha256: POLICY,
    });
    expect(mixed.binding.profileId).toBe("docsfab-publication-validation");
    expect(mixed.binding.checkIds).toEqual([
      "candidate-input-tree",
      "isolation-boundary",
      "non-package-script-gate",
    ]);
    expect(mixed.entrypointCommand).toBe(DOCUMENTATION_VALIDATION_ENTRYPOINT_COMMAND);
  });

  it("selects the exact v2 check set and binds applicability", () => {
    const applicabilitySha256 = "b".repeat(64);
    const selected = selectDocumentationValidationProfile({
      workflow: "create-documentation",
      changedPaths: ["README.md", "packages/example/docs/guide.md"],
      hostPolicySha256: POLICY,
      applicabilitySha256,
    });
    expect(selected.binding).toMatchObject({
      schemaVersion: 2,
      profileVersion: DOCUMENTATION_VALIDATION_PROFILE_VERSION_V2,
      applicabilitySha256,
      checkIds: [
        "candidate-input-tree",
        "documentation-source-applicability",
        "documentation-paths-readable",
        "documentation-relative-links",
        "documentation-navigation-targets",
        "isolation-boundary",
      ],
    });
    expect(selected.binding.selectorInputSha256).toBe(
      documentationValidationSelectorInputSha256({
        workflow: "create-documentation",
        changedPaths: ["README.md", "packages/example/docs/guide.md"],
        hostPolicySha256: POLICY,
        applicabilitySha256,
      }),
    );
    expect(() => assertDocumentationValidationBinding(selected.binding)).not.toThrow();
    expect(() =>
      assertDocumentationValidationBinding({
        ...selected.binding,
        applicabilitySha256: "c".repeat(64),
      }),
    ).not.toThrow();
    expect(() =>
      assertDocumentationValidationBinding({ ...selected.binding, profileVersion: "1" }),
    ).toThrow(DocumentationValidationError);
  });

  it.each([
    "fern/docs.yml",
    "packages/widget/fern/docs.yaml",
    "mkdocs.yml",
    "packages/widget/mkdocs.yaml",
    "docusaurus.config.ts",
    "packages/widget/sidebars.js",
    "conf.py",
    "packages/widget/docs/conf.py",
  ])("selects documentation validation for configuration-only path %s", (path) => {
    const selected = selectDocumentationValidationProfile({
      workflow: "update-documentation",
      changedPaths: [path],
      hostPolicySha256: POLICY,
      applicabilitySha256: "e".repeat(64),
    });
    expect(selected.binding.profileId).toBe("docsfab-documentation-validation");
    expect(selected.binding.checkIds).toContain("documentation-source-applicability");
  });

  it("keeps selector ordering stable for shuffled paths", () => {
    const left = selectDocumentationValidationProfile({
      workflow: "bootstrap",
      changedPaths: ["docs/b.md", "docs/a.md", "README.md"],
      hostPolicySha256: POLICY,
    });
    const right = selectDocumentationValidationProfile({
      workflow: "bootstrap",
      changedPaths: ["README.md", "docs/a.md", "docs/b.md"],
      hostPolicySha256: POLICY,
    });
    expect(left).toEqual(right);
    expect(left.binding.selectorInputSha256).toBe(
      documentationValidationSelectorInputSha256({
        workflow: "bootstrap",
        changedPaths: ["docs/a.md", "docs/b.md", "README.md"],
        hostPolicySha256: POLICY,
      }),
    );
  });

  it("changes the selector digest when workflow, paths, or host policy change", () => {
    const base = selectDocumentationValidationProfile({
      workflow: "update-documentation",
      changedPaths: ["README.md"],
      hostPolicySha256: POLICY,
    });
    const workflow = selectDocumentationValidationProfile({
      workflow: "review-documentation",
      changedPaths: ["README.md"],
      hostPolicySha256: POLICY,
    });
    const paths = selectDocumentationValidationProfile({
      workflow: "update-documentation",
      changedPaths: ["docs/guide.md"],
      hostPolicySha256: POLICY,
    });
    const policy = selectDocumentationValidationProfile({
      workflow: "update-documentation",
      changedPaths: ["README.md"],
      hostPolicySha256: "a".repeat(64),
    });
    expect(base.binding.profileId).toBe(workflow.binding.profileId);
    expect(base.binding.selectorInputSha256).not.toBe(workflow.binding.selectorInputSha256);
    expect(base.binding.selectorInputSha256).not.toBe(paths.binding.selectorInputSha256);
    expect(base.binding.selectorInputSha256).not.toBe(policy.binding.selectorInputSha256);
  });

  it("ignores repository config, patch/model text, and script presence", () => {
    const honest = selectDocumentationValidationProfile({
      workflow: "site-bootstrap",
      changedPaths: ["README.md"],
      hostPolicySha256: POLICY,
    });
    const attacked = selectDocumentationValidationProfile(
      {
        workflow: "site-bootstrap",
        changedPaths: ["README.md"],
        hostPolicySha256: POLICY,
      },
      serializedAttack,
    );
    expect(attacked).toEqual(honest);
    expect(
      resolveHostDocumentationValidator(
        "docsfab-documentation-validation",
        DOCUMENTATION_VALIDATION_PROFILE_VERSION,
        serializedAttack,
      ).entrypointCommand,
    ).toBe(DOCUMENTATION_VALIDATION_ENTRYPOINT_COMMAND);
    expect(attacked.binding.validatorIdentity).toBe("docsfab-documentation-validator");
  });

  it("does not treat docsfab test as a documentation validation profile", () => {
    expect(DOCUMENTATION_VALIDATION_PROFILE_IDS).not.toContain("docsfab-test");
    expect(DOCUMENTATION_VALIDATION_PROFILE_IDS.join(",")).not.toContain("offline-product-test");
    expect(OFFLINE_PRODUCT_TEST_STEPS).toContain("validation");
    expect(DOCUMENTATION_VALIDATION_PROFILE_IDS).not.toEqual(
      expect.arrayContaining([...OFFLINE_PRODUCT_TEST_STEPS]),
    );
  });

  it("rejects reconstructed bindings that swap the check set or validator", () => {
    const selected = selectDocumentationValidationProfile({
      workflow: "update-documentation",
      changedPaths: ["README.md"],
      hostPolicySha256: POLICY,
    });
    expect(() => assertDocumentationValidationBinding(selected.binding)).not.toThrow();
    expect(() =>
      assertDocumentationValidationBinding({
        ...selected.binding,
        checkIds: ["candidate-input-tree"],
      }),
    ).toThrow(DocumentationValidationError);
    expect(() =>
      assertDocumentationValidationBinding({
        ...selected.binding,
        validatorIdentity: "docsfab-publication-validator",
      }),
    ).toThrow(DocumentationValidationError);
    expect(() =>
      assertDocumentationValidationBinding(
        JSON.parse(JSON.stringify({ ...selected.binding, profileId: "forged-profile" })),
      ),
    ).toThrow(DocumentationValidationError);
  });

  it("does not read package.json or .docsfab.json to resolve a validator", async () => {
    const root = await temporaryDirectories.create("docsfab-validation-profile-");
    await writeFile(
      join(root, "package.json"),
      `${JSON.stringify({ scripts: { check: "npm run lint" } })}\n`,
    );
    await writeFile(
      join(root, ".docsfab.json"),
      `${JSON.stringify({ validationCommand: "npm run check" })}\n`,
    );
    await mkdir(join(root, "scripts"));
    await writeFile(join(root, "scripts", "check"), "#!/bin/sh\nexit 0\n");
    const selected = selectDocumentationValidationProfile(
      {
        workflow: "foundation",
        changedPaths: ["package.json"],
        hostPolicySha256: POLICY,
      },
      {
        repositoryConfig: { validationCommand: "npm run check" },
        scriptPresence: ["package.json", "scripts/check", join(root, ".docsfab.json")],
      },
    );
    expect(selected.binding.profileId).toBe("docsfab-publication-validation");
    expect(selected.entrypointCommand).not.toBe("npm run check");
    expect(selected.entrypointCommand).not.toBe("true");
    expect(createHash("sha256").update(selected.entrypointCommand).digest("hex")).toBe(
      createHash("sha256").update(DOCUMENTATION_VALIDATION_ENTRYPOINT_COMMAND).digest("hex"),
    );
  });

  it("passes a ROUTER-like multipage Fern candidate using only exact changed paths", async () => {
    const root = await temporaryDirectories.create("docsfab-router-structural-");
    await mkdir(join(root, "fern"));
    await mkdir(join(root, "docs", "guides"), { recursive: true });
    await writeFile(join(root, "docs", "guides", "start.mdx"), "[Next](./advanced.mdx)\n");
    await writeFile(join(root, "docs", "guides", "advanced.mdx"), "Advanced\n");
    await writeFile(
      join(root, "fern", "docs.yml"),
      "navigation:\n  - section: Guides\n    contents:\n      - page: ../docs/guides/start.mdx\n      - page: ../docs/guides/advanced.mdx\n",
    );
    await expect(
      validateStructuralDocumentation(root, ["docs/guides/start.mdx", "fern/docs.yml"]),
    ).resolves.toEqual([
      { id: "documentation-paths-readable", status: "passed" },
      { id: "documentation-relative-links", status: "passed" },
      { id: "fern-navigation-targets", status: "passed" },
    ]);
  });

  it.each([
    ["missing target", "[Gone](./missing.mdx)\n", "documentation-relative-links", "failed"],
    [
      "unsupported Fern syntax",
      "navigation:\n  - page: { path: ../docs/a.mdx }\n",
      "fern-navigation-targets",
      "limitation",
    ],
    [
      "unsupported YAML tag",
      "navigation:\n  - page: Page\n    path: !unsupported ../docs/a.mdx\n",
      "fern-navigation-targets",
      "limitation",
    ],
    [
      "cyclic YAML alias",
      "navigation: &nav\n  - section: Loop\n    contents: *nav\n",
      "fern-navigation-targets",
      "limitation",
    ],
    ["zero recognized Fern targets", "navigation: [\n", "fern-navigation-targets", "limitation"],
  ] as const)("returns a stable typed result for %s", async (_label, source, check, status) => {
    const root = await temporaryDirectories.create("docsfab-router-structural-");
    if (check === "fern-navigation-targets") {
      await mkdir(join(root, "fern"));
      await writeFile(join(root, "fern", "docs.yml"), source);
      await expect(validateStructuralDocumentation(root, ["fern/docs.yml"])).rejects.toMatchObject({
        check,
        status,
      } satisfies Partial<StructuralDocumentationValidationError>);
    } else {
      await writeFile(join(root, "README.md"), source);
      await expect(validateStructuralDocumentation(root, ["README.md"])).rejects.toMatchObject({
        check,
        status,
      } satisfies Partial<StructuralDocumentationValidationError>);
    }
  });

  it("validates versioned Fern navigation, reference links, and reachability", async () => {
    const root = await temporaryDirectories.create("docsfab-router-versioned-");
    await mkdir(join(root, "fern", "versions"), { recursive: true });
    await mkdir(join(root, "docs", "guides"), { recursive: true });
    await writeFile(
      join(root, "docs", "guides", "start.md"),
      "[Next][advanced]\n\n[advanced]: ./advanced.md\n",
    );
    await writeFile(join(root, "docs", "guides", "advanced.md"), "Advanced\n");
    await writeFile(
      join(root, "fern", "versions", "nightly.yml"),
      "navigation:\n  - section: Guides\n    contents:\n      - page: Start\n        path: ../../docs/guides/start.md\n      - page: Advanced\n        path: ../../docs/guides/advanced.md\n",
    );
    await expect(
      validateStructuralDocumentation(root, [
        "docs/guides/start.md",
        "docs/guides/advanced.md",
        "fern/versions/nightly.yml",
      ]),
    ).resolves.toEqual([
      { id: "documentation-paths-readable", status: "passed" },
      { id: "documentation-relative-links", status: "passed" },
      { id: "fern-navigation-targets", status: "passed" },
    ]);
  });

  it("follows the pinned ROUTER version index, projection map, and site-root routes", async () => {
    // Topology retained from tech-docs/router@5b07299e9a105b6eccdc526e19eb253be12a55bb.
    const root = await temporaryDirectories.create("docsfab-router-route-map-");
    await mkdir(join(root, "fern", "versions"), { recursive: true });
    await mkdir(join(root, "docs", "collections"), { recursive: true });
    await mkdir(join(root, "fern", "pages", "collections"), { recursive: true });
    await mkdir(join(root, "fern", "pages", "about", "architecture"), { recursive: true });
    for (const [canonical, projection] of [
      ["README.md", "_index.mdx"],
      ["guide.md", "guide.mdx"],
      ["reference.md", "concepts.mdx"],
    ] as const) {
      await writeFile(join(root, "docs", "collections", canonical), `Canonical ${canonical}\n`);
      await writeFile(
        join(root, "fern", "pages", "collections", projection),
        projection === "_index.mdx"
          ? '<Card title="Guide" href="/router/collections/guide">Guide</Card>\n<Card title="Concepts" href="/router/collections/concepts">Concepts</Card>\n'
          : `[Storage](/router/about/architecture/skill-storage)\n`,
      );
    }
    await writeFile(
      join(root, "fern", "pages", "about", "architecture", "skill-storage.mdx"),
      "Skill storage\n",
    );
    await writeFile(
      join(root, "fern", "pages", "about", "architecture", "index.mdx"),
      "Architecture\n",
    );
    await writeFile(
      join(root, "fern", "SOURCE_MAP.md"),
      [
        "# Fern Source Map",
        "",
        "| Fern area | Current Fern files | Canonical sources | Steward lenses | Publish notes |",
        "| --- | --- | --- | --- | --- |",
        "| About | `pages/about/**` | `docs/architecture/**` | Docs | Published |",
        "| Collections | `pages/collections/**` | `docs/collections/**` | Docs | Published |",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(root, "fern", "docs.yml"),
      "instances:\n  - url: router.docs.buildwithfern.com/router\nversions:\n  - path: ./versions/nightly.yml\n",
    );
    await writeFile(
      join(root, "fern", "versions", "nightly.yml"),
      [
        "navigation:",
        "  - section: About",
        "    contents:",
        "      - folder: ../pages/about/architecture",
        "  - section: Collections",
        "    contents:",
        "      - page: Overview",
        "        path: ../pages/collections/_index.mdx",
        "      - page: Guide",
        "        path: ../pages/collections/guide.mdx",
        "      - page: Concepts",
        "        path: ../pages/collections/concepts.mdx",
        "",
      ].join("\n"),
    );
    await expect(
      validateStructuralDocumentation(root, [
        "docs/collections/README.md",
        "docs/collections/guide.md",
        "docs/collections/reference.md",
        "fern/pages/collections/_index.mdx",
        "fern/pages/collections/guide.mdx",
        "fern/pages/collections/concepts.mdx",
        "fern/docs.yml",
      ]),
    ).resolves.toEqual([
      { id: "documentation-paths-readable", status: "passed" },
      { id: "documentation-relative-links", status: "passed" },
      { id: "fern-navigation-targets", status: "passed" },
    ]);
  });

  it("fails closed when an explicit canonical projection mapping cannot be completed", async () => {
    const root = await temporaryDirectories.create("docsfab-router-projection-limitation-");
    await mkdir(join(root, "docs", "collections"), { recursive: true });
    await mkdir(join(root, "fern", "pages", "collections"), { recursive: true });
    await writeFile(join(root, "docs", "collections", "guide.md"), "Canonical\n");
    await writeFile(join(root, "fern", "pages", "collections", "guide.mdx"), "Projection\n");
    await writeFile(
      join(root, "fern", "SOURCE_MAP.md"),
      "| Fern area | Current Fern files | Canonical sources | Steward lenses | Publish notes |\n| --- | --- | --- | --- | --- |\n| Collections | `pages/collections/**` | `docs/collections/**` | Docs | Published |\n",
    );
    await writeFile(
      join(root, "fern", "docs.yml"),
      "navigation:\n  - page: Guide\n    path: ./pages/collections/guide.mdx\n",
    );
    await expect(
      validateStructuralDocumentation(root, ["docs/collections/guide.md"]),
    ).rejects.toMatchObject({
      check: "fern-navigation-targets",
      status: "limitation",
    } satisfies Partial<StructuralDocumentationValidationError>);
  });

  it("rejects broken and conflicting site-root routes", async () => {
    const root = await temporaryDirectories.create("docsfab-router-route-negative-");
    await mkdir(join(root, "fern", "versions"), { recursive: true });
    await mkdir(join(root, "fern", "pages", "router"), { recursive: true });
    await writeFile(join(root, "docs", "page.md"), "[Broken](/router/missing)\n").catch(
      async () => {
        await mkdir(join(root, "docs"));
        await writeFile(join(root, "docs", "page.md"), "[Broken](/router/missing)\n");
      },
    );
    await writeFile(
      join(root, "fern", "docs.yml"),
      "instances:\n  - instance: router\nversions:\n  - path: ./versions/nightly.yml\n",
    );
    await writeFile(
      join(root, "fern", "versions", "nightly.yml"),
      "navigation:\n  - page: Page\n    path: ../pages/router/page.md\n",
    );
    await expect(validateStructuralDocumentation(root, ["docs/page.md"])).rejects.toMatchObject({
      check: "fern-navigation-targets",
      status: "failed",
    });

    await writeFile(
      join(root, "fern", "pages", "router", "page.md"),
      "canonical: ../../../docs/router/page.md\nProjection\n",
    );
    await writeFile(
      join(root, "fern", "versions", "other.yml"),
      "navigation:\n  - page: Page\n    path: ../pages/router/page.md\n",
    );
    await writeFile(join(root, "docs", "page.md"), "[Page](/router/page)\n");
    await writeFile(
      join(root, "fern", "versions", "nightly.yml"),
      "navigation:\n  - page: Page\n    path: ../pages/router/page.md\n  - page: Duplicate\n    path: ../../docs/router/page.md\n",
    );
    await mkdir(join(root, "docs", "router"), { recursive: true });
    await writeFile(join(root, "docs", "router", "page.md"), "Canonical\n");
    await expect(validateStructuralDocumentation(root, ["docs/page.md"])).rejects.toMatchObject({
      check: "documentation-relative-links",
      status: "failed",
    });
  });

  it("discovers version navigation from fern/versions when the index is absent", async () => {
    const root = await temporaryDirectories.create("docsfab-router-directory-nav-");
    await mkdir(join(root, "fern", "versions"), { recursive: true });
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "docs", "page.md"), "Page\n");
    await writeFile(
      join(root, "fern", "versions", "nightly.yml"),
      "navigation:\n  - page: Page\n    path: ../../docs/page.md\n",
    );
    await expect(validateStructuralDocumentation(root, ["docs/page.md"])).resolves.toHaveLength(3);
  });

  it.each([
    ["missing version navigation", "./versions/missing.yml"],
    ["version traversal", "../../outside.yml"],
  ] as const)("rejects %s from a top-level index", async (_label, versionPath) => {
    const root = await temporaryDirectories.create("docsfab-router-version-negative-");
    await mkdir(join(root, "fern", "versions"), { recursive: true });
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "docs", "page.md"), "Page\n");
    await writeFile(join(root, "fern", "docs.yml"), `versions:\n  - path: ${versionPath}\n`);
    await expect(validateStructuralDocumentation(root, ["docs/page.md"])).rejects.toMatchObject({
      check: "documentation-paths-readable",
      status: "failed",
    } satisfies Partial<StructuralDocumentationValidationError>);
  });

  it("rejects malformed Fern YAML and source-map path syntax as typed limitations", async () => {
    const root = await temporaryDirectories.create("docsfab-router-malformed-");
    await mkdir(join(root, "fern", "pages"), { recursive: true });
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "docs", "page.md"), "Page\n");
    await writeFile(join(root, "fern", "docs.yml"), "navigation: [\n");
    await expect(validateStructuralDocumentation(root, ["docs/page.md"])).rejects.toMatchObject({
      check: "fern-navigation-targets",
      status: "limitation",
    } satisfies Partial<StructuralDocumentationValidationError>);

    await writeFile(
      join(root, "fern", "docs.yml"),
      "navigation:\n  - page: Page\n    path: ./pages/page.mdx\n",
    );
    await writeFile(join(root, "fern", "pages", "page.mdx"), "Projection\n");
    await writeFile(
      join(root, "fern", "SOURCE_MAP.md"),
      "| Fern area | Current Fern files | Canonical sources | Steward lenses | Publish notes |\n| --- | --- | --- | --- | --- |\n| Bad | `pages/**/escape` | `docs/**` | Docs | Bad |\n",
    );
    await expect(
      validateStructuralDocumentation(root, ["docs/page.md", "fern/pages/page.mdx"]),
    ).rejects.toMatchObject({
      check: "fern-navigation-targets",
      status: "limitation",
    } satisfies Partial<StructuralDocumentationValidationError>);

    await writeFile(
      join(root, "fern", "SOURCE_MAP.md"),
      "| Fern area | Current Fern files | Canonical sources | Steward lenses | Publish notes |\n| --- | --- | --- | --- | --- |\n| Bad | `pages/**` | `docs/**` and `docs/[broken | Docs | Bad |\n",
    );
    await expect(
      validateStructuralDocumentation(root, ["docs/page.md", "fern/pages/page.mdx"]),
    ).rejects.toMatchObject({
      check: "fern-navigation-targets",
      status: "limitation",
    } satisfies Partial<StructuralDocumentationValidationError>);
  });

  it("rejects an orphan page and symlink escape fixtures", async () => {
    const root = await temporaryDirectories.create("docsfab-router-boundaries-");
    await mkdir(join(root, "fern"), { recursive: true });
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "home.md"), "home\n");
    await writeFile(join(root, "docs", "orphan.md"), "orphan\n");
    await writeFile(
      join(root, "fern", "docs.yml"),
      "navigation:\n  - page: Home\n    path: ../docs/home.md\n",
    );
    await expect(validateStructuralDocumentation(root, ["docs/orphan.md"])).rejects.toMatchObject({
      check: "fern-navigation-targets",
      status: "failed",
    } satisfies Partial<StructuralDocumentationValidationError>);

    const outside = join(root, "outside.md");
    await writeFile(outside, "outside\n");
    await symlink(outside, join(root, "docs", "escape.md"));
    await expect(validateStructuralDocumentation(root, ["docs/escape.md"])).rejects.toMatchObject({
      check: "documentation-paths-readable",
      status: "failed",
    } satisfies Partial<StructuralDocumentationValidationError>);

    await writeFile(join(root, "docs", "link.md"), "[Outside](./target.md)\n");
    await symlink(outside, join(root, "docs", "target.md"));
    await expect(validateStructuralDocumentation(root, ["docs/link.md"])).rejects.toMatchObject({
      check: "documentation-relative-links",
      status: "failed",
    } satisfies Partial<StructuralDocumentationValidationError>);
  });

  it("rejects a symlink escape discovered through folder navigation", async () => {
    const root = await temporaryDirectories.create("docsfab-router-folder-symlink-");
    const outsideRoot = await temporaryDirectories.create("docsfab-router-folder-outside-");
    await mkdir(join(root, "fern", "pages", "group"), { recursive: true });
    await writeFile(join(root, "fern", "pages", "group", "index.mdx"), "Index\n");
    const outside = join(outsideRoot, "outside.mdx");
    await writeFile(outside, "Outside fixture\n");
    await symlink(outside, join(root, "fern", "pages", "group", "escape.mdx"));
    await writeFile(join(root, "fern", "docs.yml"), "navigation:\n  - folder: ./pages/group\n");

    await expect(
      validateStructuralDocumentation(root, ["fern/pages/group/index.mdx"]),
    ).rejects.toMatchObject({
      check: "fern-navigation-targets",
      status: "failed",
    } satisfies Partial<StructuralDocumentationValidationError>);
  });

  it("uses explicit Fern slugs instead of physical page aliases", async () => {
    const root = await temporaryDirectories.create("docsfab-router-slug-route-");
    await mkdir(join(root, "fern", "pages"), { recursive: true });
    await writeFile(join(root, "fern", "pages", "page.mdx"), "[Renamed](/router/renamed)\n");
    await writeFile(
      join(root, "fern", "docs.yml"),
      "instances:\n  - url: example.test/router\nnavigation:\n  - page: Page\n    path: ./pages/page.mdx\n    slug: renamed\n",
    );
    await expect(
      validateStructuralDocumentation(root, ["fern/pages/page.mdx"]),
    ).resolves.toHaveLength(3);

    await writeFile(join(root, "fern", "pages", "page.mdx"), "[Physical](/router/page)\n");
    await expect(
      validateStructuralDocumentation(root, ["fern/pages/page.mdx"]),
    ).rejects.toMatchObject({
      check: "documentation-relative-links",
      status: "failed",
    } satisfies Partial<StructuralDocumentationValidationError>);
  });

  it("validates static Card href targets through the Fern route map", async () => {
    const root = await temporaryDirectories.create("docsfab-router-card-route-");
    await mkdir(join(root, "fern", "pages"), { recursive: true });
    await writeFile(
      join(root, "fern", "pages", "page.mdx"),
      '<Card title="Broken" href="/router/missing">Broken</Card>\n',
    );
    await writeFile(
      join(root, "fern", "docs.yml"),
      "instances:\n  - url: example.test/router\nnavigation:\n  - page: Page\n    path: ./pages/page.mdx\n    slug: page\n",
    );

    await expect(
      validateStructuralDocumentation(root, ["fern/pages/page.mdx"]),
    ).rejects.toMatchObject({
      check: "documentation-relative-links",
      status: "failed",
    } satisfies Partial<StructuralDocumentationValidationError>);

    await writeFile(
      join(root, "fern", "pages", "page.mdx"),
      '<Card title="A > B" href="/router/page">Valid</Card>\n',
    );
    await expect(
      validateStructuralDocumentation(root, ["fern/pages/page.mdx"]),
    ).resolves.toHaveLength(3);

    await writeFile(
      join(root, "fern", "pages", "page.mdx"),
      '<Card title="Guide 🚀" href="/router/page">Valid</Card>\n',
    );
    await expect(
      validateStructuralDocumentation(root, ["fern/pages/page.mdx"]),
    ).resolves.toHaveLength(3);

    for (const source of [
      '<Card title="A > B" href="/router/missing">Broken</Card>\n',
      '<Card title="Guide 🚀" href="/router/missing">Broken</Card>\n',
    ]) {
      await writeFile(join(root, "fern", "pages", "page.mdx"), source);
      await expect(
        validateStructuralDocumentation(root, ["fern/pages/page.mdx"]),
      ).rejects.toMatchObject({
        check: "documentation-relative-links",
        status: "failed",
      } satisfies Partial<StructuralDocumentationValidationError>);
    }

    for (const source of [
      '<Card title={a > b ? "A" : "B"} href="/router/missing">Unsupported</Card>\n',
      `<Card title={"} href='/router/page'"} href="/router/missing">Unsupported</Card>\n`,
    ]) {
      await writeFile(join(root, "fern", "pages", "page.mdx"), source);
      await expect(
        validateStructuralDocumentation(root, ["fern/pages/page.mdx"]),
      ).rejects.toMatchObject({
        check: "documentation-relative-links",
        status: "limitation",
      } satisfies Partial<StructuralDocumentationValidationError>);
    }

    await writeFile(
      join(root, "fern", "pages", "page.mdx"),
      '<Card href="/router/page" href="/router/missing">Ambiguous</Card>\n',
    );
    await expect(
      validateStructuralDocumentation(root, ["fern/pages/page.mdx"]),
    ).rejects.toMatchObject({
      check: "documentation-relative-links",
      status: "limitation",
    } satisfies Partial<StructuralDocumentationValidationError>);
  });

  it("translates unsupported folder descendant routes to a typed limitation", async () => {
    const root = await temporaryDirectories.create("docsfab-router-folder-route-limit-");
    await mkdir(join(root, "fern", "pages", "group"), { recursive: true });
    await writeFile(join(root, "fern", "pages", "group", "index.mdx"), "Index\n");
    await writeFile(join(root, "fern", "pages", "group", "spaced name.mdx"), "Spaced\n");
    await writeFile(
      join(root, "fern", "docs.yml"),
      "navigation:\n  - folder: ./pages/group\n    slug: group\n",
    );

    await expect(
      validateStructuralDocumentation(root, ["fern/pages/group/index.mdx"]),
    ).rejects.toMatchObject({
      check: "fern-navigation-targets",
      status: "limitation",
    } satisfies Partial<StructuralDocumentationValidationError>);
  });

  it("rejects a missing reference target as a broken link", async () => {
    const root = await temporaryDirectories.create("docsfab-router-reference-");
    await writeFile(join(root, "README.md"), "[Next][missing]\n\n[missing]: ./missing.md\n");
    await expect(validateStructuralDocumentation(root, ["README.md"])).rejects.toMatchObject({
      check: "documentation-relative-links",
      status: "failed",
    } satisfies Partial<StructuralDocumentationValidationError>);
  });

  it("ignores deleted candidates in a valid add-and-restructure fixture", async () => {
    const root = await temporaryDirectories.create("docsfab-router-restructure-");
    await mkdir(join(root, "fern"));
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "new.md"), "New page\n");
    await writeFile(
      join(root, "fern", "docs.yml"),
      "navigation:\n  - page: New\n    path: ../docs/new.md\n",
    );
    await expect(
      validateStructuralDocumentation(root, [
        { path: "docs/old.md", status: "deleted" },
        { path: "docs/new.md", status: "added" },
        { path: "fern/docs.yml", status: "modified" },
      ]),
    ).resolves.toEqual([
      { id: "documentation-paths-readable", status: "passed" },
      { id: "documentation-relative-links", status: "passed" },
      { id: "fern-navigation-targets", status: "passed" },
    ]);
  });

  it("validates a bare-instance folder with index and nested pages", async () => {
    const root = await temporaryDirectories.create("docsfab-router-folder-integrated-");
    await mkdir(join(root, "fern", "versions"), { recursive: true });
    await mkdir(join(root, "docs", "guides", "nested"), { recursive: true });
    await writeFile(join(root, "docs", "guides", "index.md"), "[About](/router/guides/about)\n");
    await writeFile(join(root, "docs", "guides", "about.md"), "About\n");
    await writeFile(join(root, "docs", "guides", "nested", "topic.md"), "Topic\n");
    await writeFile(
      join(root, "fern", "docs.yml"),
      "instances:\n  - instance: router\nversions:\n  - path: ./versions/nightly.yml\n",
    );
    await writeFile(
      join(root, "fern", "versions", "nightly.yml"),
      "navigation:\n  - folder: ../../docs/guides\n",
    );
    await expect(
      validateStructuralDocumentation(root, [
        "docs/guides/index.md",
        "docs/guides/about.md",
        "docs/guides/nested/topic.md",
      ]),
    ).resolves.toHaveLength(3);
  });
});
