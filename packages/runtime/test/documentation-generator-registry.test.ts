// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  SOURCE_AWARE_STRUCTURAL_DOCUMENTATION_CHECK_IDS,
  validateSourceAwareStructuralDocumentation,
} from "../src/delivery/structural-documentation-validator.js";
import { selectDocumentationValidationProfile } from "../src/delivery/validation-profile.js";
import {
  createDocumentationSourceApplicability,
  deriveDocumentationSourceApplicability,
} from "../src/repository/documentation-source-applicability.js";
import {
  DOCUMENTATION_GENERATORS_WITHOUT_ADAPTER,
  DOCUMENTATION_SOURCE_ADAPTER_IDS,
  DOCUMENTATION_SOURCE_CAPABILITIES,
  DOCUMENTATION_SOURCE_CAPABILITY_STATES,
  DOCUMENTATION_SOURCE_CONFIGURATION_LOCATIONS,
  DOCUMENTATION_SOURCE_MARKUP_EXTENSIONS,
  documentationSourceLimitationForAdapter,
  resolveDocumentationSourceAdapter,
  type DocumentationSourceAdapterId,
} from "../src/repository/documentation-source-support.js";
import { buildRepositoryDiscoveryInventory } from "../src/repository/inventory.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import { initFixtureRepo } from "./helpers/git.js";
import { temporaryRoots } from "./helpers/temp.js";

const roots = temporaryRoots();
const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const POLICY = "d".repeat(64);
/** Git fixture plus a full inventory build; matches the inventory suite's headroom. */
const INVENTORY_TEST_TIMEOUT_MS = 180_000;

const adapterLocations = DOCUMENTATION_SOURCE_ADAPTER_IDS.flatMap((adapterId) =>
  resolveDocumentationSourceAdapter(adapterId).configurationLocations.map(
    (location) => [adapterId, location] as const,
  ),
);

/**
 * Registered navigation spellings that navigation observation or the Content IR
 * does not read yet. Remove an entry only together with the consumer reading it.
 */
const OBSERVATION_NAVIGATION_GAPS = ["fern/docs.yaml", "sidebars.cts", "sidebars.mts"];
const CONTENT_IR_NAVIGATION_GAPS = [
  "fern/docs.yaml",
  "fern/docs.yml",
  "sidebars.cts",
  "sidebars.mts",
];

/**
 * The limitation each adapter's own root records, written out rather than
 * derived so a regression in `documentationSourceLimitationForAdapter` fails.
 */
const EXPECTED_ADAPTER_LIMITATIONS: Readonly<
  Record<DocumentationSourceAdapterId, readonly string[]>
> = {
  "plain-markdown": [],
  mkdocs: [],
  docusaurus: [],
  sphinx: [],
  fern: [],
  "jupyter-book": ["navigation-not-checked"],
};

function applicabilityInput(
  root: string,
  path: string,
  status: "added" | "modified" | "deleted" = "modified",
) {
  return {
    candidateRoot: root,
    repositoryIdentitySha256: digest("repository"),
    baseRevision: "a".repeat(40),
    candidateInputTreeSha256: digest("candidate"),
    changedPaths: [{ path, status }],
  };
}

async function writeRelative(root: string, path: string, contents: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), contents);
}

/** Read a module-private recognizer set that is compared with the registry, not derived from it. */
async function sourceStringSet(file: string, name: string): Promise<string[]> {
  const source = await readFile(resolve(runtimeRoot, file), "utf8");
  const match = new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]\\)`, "u").exec(source);
  expect(match, `${file} declares ${name}`).not.toBeNull();
  return [...(match?.[1] ?? "").matchAll(/"([^"]+)"/gu)].map((item) => item[1] ?? "");
}

function registryNavigationNames(): string[] {
  return DOCUMENTATION_SOURCE_ADAPTER_IDS.flatMap((adapterId) =>
    resolveDocumentationSourceAdapter(adapterId).navigationLocations.map((location) =>
      adapterId === "fern" ? location : posix.basename(location),
    ),
  ).sort();
}

describe("documentation generator registry", () => {
  it("declares one state for every capability of each of the six adapters", () => {
    expect(DOCUMENTATION_SOURCE_ADAPTER_IDS).toHaveLength(6);
    expect(DOCUMENTATION_SOURCE_ADAPTER_IDS).toContain("jupyter-book");
    for (const adapterId of DOCUMENTATION_SOURCE_ADAPTER_IDS) {
      const adapter = resolveDocumentationSourceAdapter(adapterId);
      expect(adapter.adapterId).toBe(adapterId);
      expect(Object.keys(adapter.capabilities).sort()).toEqual(
        [...DOCUMENTATION_SOURCE_CAPABILITIES].sort(),
      );
      for (const state of Object.values(adapter.capabilities))
        expect(DOCUMENTATION_SOURCE_CAPABILITY_STATES).toContain(state);
      expect(adapter.capabilities.detect).toBe("supported");
      for (const location of adapter.navigationLocations)
        expect(adapter.configurationLocations).toContain(location);
      expect(Object.isFrozen(adapter.capabilities)).toBe(true);
      expect(Object.isFrozen(adapter.configurationLocations)).toBe(true);
    }
  });

  it("assigns each configuration spelling to exactly one generator", () => {
    const owners = new Map<string, string>();
    const claim = (location: string, generator: string) => {
      expect(owners.get(location), `${location} is claimed twice`).toBeUndefined();
      owners.set(location, generator);
    };
    for (const [adapterId, location] of adapterLocations) claim(location, adapterId);
    for (const [generator, entry] of Object.entries(DOCUMENTATION_GENERATORS_WITHOUT_ADAPTER))
      for (const location of entry.configurationLocations) claim(location, generator);
    expect(DOCUMENTATION_SOURCE_CONFIGURATION_LOCATIONS).toEqual(
      adapterLocations.map(([, location]) => location).sort(),
    );
    expect(DOCUMENTATION_SOURCE_MARKUP_EXTENSIONS).toEqual([".md", ".mdx", ".rst"]);
  });

  it("records each adapter's own limitation from a written-out table", () => {
    expect(
      Object.fromEntries(
        DOCUMENTATION_SOURCE_ADAPTER_IDS.map((adapterId) => [
          adapterId,
          [documentationSourceLimitationForAdapter(adapterId)].filter(Boolean),
        ]),
      ),
    ).toEqual(EXPECTED_ADAPTER_LIMITATIONS);
    for (const adapterId of DOCUMENTATION_SOURCE_ADAPTER_IDS) {
      const adapter = resolveDocumentationSourceAdapter(adapterId);
      // A fallback is what makes a validate capability partial rather than unsupported.
      expect(adapter.validationFallback !== null, adapterId).toBe(
        adapter.capabilities.validate === "partial",
      );
    }
  });

  it("binds every registered configuration spelling in source applicability", async () => {
    for (const [adapterId, location] of adapterLocations) {
      for (const root of [".", "packages/widget"]) {
        const path = root === "." ? location : `${root}/${location}`;
        const candidate = await roots.create("docsfab-registry-applicability-");
        await writeRelative(candidate, path, "configuration\n");
        const applicability = await deriveDocumentationSourceApplicability(
          applicabilityInput(candidate, path),
        );
        expect(applicability.roots, path).toEqual([
          expect.objectContaining({
            root,
            adapterId,
            configurationFiles: [{ path, sha256: digest("configuration\n") }],
            navigationMode: "explicit",
            limitations: EXPECTED_ADAPTER_LIMITATIONS[adapterId],
          }),
        ]);
      }
    }
  });

  it("selects documentation validation for every registered configuration spelling", () => {
    const select = (path: string) =>
      selectDocumentationValidationProfile({
        workflow: "update-documentation",
        changedPaths: [path],
        hostPolicySha256: POLICY,
        applicabilitySha256: "e".repeat(64),
      }).binding.profileId;
    for (const [, location] of adapterLocations) {
      expect(select(location), location).toBe("docsfab-documentation-validation");
      expect(select(`packages/widget/${location}`), location).toBe(
        "docsfab-documentation-validation",
      );
    }
    for (const path of ["site/mkdocs.yml", "packages/widget/site/conf.py", "_config.yml"])
      expect(select(path), path).toBe("docsfab-publication-validation");
  });

  it("names every registered generator in repository inventory", {
    timeout: INVENTORY_TEST_TIMEOUT_MS,
  }, async () => {
    const repository = await roots.create("docsfab-registry-inventory-");
    const files: Record<string, string> = {
      "README.md": "# Product\n",
      "package.json": JSON.stringify({
        dependencies: Object.fromEntries(
          [
            ...DOCUMENTATION_SOURCE_ADAPTER_IDS.flatMap(
              (adapterId) => resolveDocumentationSourceAdapter(adapterId).packageDependencies,
            ),
            ...Object.values(DOCUMENTATION_GENERATORS_WITHOUT_ADAPTER).flatMap(
              (entry) => entry.packageDependencies,
            ),
          ].map((name) => [name, "1.0.0"]),
        ),
      }),
    };
    const expected = new Map<string, string[]>();
    const record = (
      generator: string,
      paths: readonly string[],
      dependencies: readonly string[],
    ) => {
      for (const path of paths) files[path] = "configuration\n";
      expected.set(generator, [...paths, ...(dependencies.length > 0 ? ["package.json"] : [])]);
    };
    for (const adapterId of DOCUMENTATION_SOURCE_ADAPTER_IDS) {
      const adapter = resolveDocumentationSourceAdapter(adapterId);
      if (adapter.configurationLocations.length + adapter.packageDependencies.length > 0)
        record(adapterId, adapter.configurationLocations, adapter.packageDependencies);
    }
    for (const [generator, entry] of Object.entries(DOCUMENTATION_GENERATORS_WITHOUT_ADAPTER))
      record(generator, entry.configurationLocations, entry.packageDependencies);
    await initFixtureRepo(repository, files, {
      message: "registry inventory fixture",
    });
    const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
    try {
      const inventory = await buildRepositoryDiscoveryInventory({
        workspace,
      });
      const generators = new Map(
        inventory.signals
          .filter((item) => item.category === "site-generator")
          .map((item) => [item.name, [...item.paths]]),
      );
      expect(Object.fromEntries(generators)).toEqual(
        Object.fromEntries([...expected].map(([name, paths]) => [name, [...paths].sort()])),
      );
    } finally {
      await workspace.dispose();
    }
  });

  it("matches the navigation names that observation and the Content IR read", async () => {
    const observation = [
      ...(await sourceStringSet(
        "src/repository/navigation-observation.ts",
        "SUPPORTED_NAVIGATION_NAMES",
      )),
      ...(await sourceStringSet(
        "src/repository/navigation-observation.ts",
        "UNSUPPORTED_NAVIGATION_NAMES",
      )),
    ];
    const fernIndex = /const FERN_INDEX_PATH = "([^"]+)";/u.exec(
      await readFile(resolve(runtimeRoot, "src/repository/fern-navigation.ts"), "utf8"),
    )?.[1];
    expect([...observation, fernIndex].sort()).toEqual(
      registryNavigationNames().filter((name) => !OBSERVATION_NAVIGATION_GAPS.includes(name)),
    );
    const contentIr = [
      ...(await sourceStringSet("src/content-ir/indexer.ts", "NAVIGATION_NAMES")),
      ...(await sourceStringSet("src/content-ir/indexer.ts", "UNSUPPORTED_NAVIGATION_NAMES")),
    ];
    expect(contentIr.sort()).toEqual(
      registryNavigationNames().filter((name) => !CONTENT_IR_NAVIGATION_GAPS.includes(name)),
    );
  });

  it("lets structural validation run only adapters whose validate capability is not unsupported", async () => {
    const source = await readFile(
      resolve(runtimeRoot, "src/delivery/structural-documentation-validator.ts"),
      "utf8",
    );
    const implemented = /!\[([^\]]*)\]\.includes\(\s*root\.adapterId/u.exec(source)?.[1];
    expect(implemented, "the structural validator names its implemented adapters").toBeDefined();
    expect([...(implemented ?? "").matchAll(/"([^"]+)"/gu)].map((item) => item[1]).sort()).toEqual(
      DOCUMENTATION_SOURCE_ADAPTER_IDS.filter(
        (adapterId: DocumentationSourceAdapterId) =>
          resolveDocumentationSourceAdapter(adapterId).capabilities.validate !== "unsupported",
      ).sort(),
    );
  });
});

describe("recognizer disagreements the registry resolves", () => {
  it("reports competing root configurations instead of rejecting their unsorted binding", async () => {
    // Before: the hand-written list bound mkdocs.yml ahead of docusaurus.config.js,
    // so the record failed its own byte-order check with invalid-value.
    const root = await roots.create("docsfab-registry-ambiguous-");
    await writeRelative(root, "mkdocs.yml", "site_name: Example\n");
    await writeRelative(root, "docusaurus.config.js", "export default {};\n");
    await writeRelative(root, "docs/index.md", "# Example\n");
    const applicability = await deriveDocumentationSourceApplicability(
      applicabilityInput(root, "docs/index.md"),
    );
    expect(applicability.roots[0]).toMatchObject({
      adapterId: "plain-markdown",
      configurationFiles: [{ path: "docusaurus.config.js" }, { path: "mkdocs.yml" }],
      limitations: ["ambiguous-root-ownership", "unsupported-relevant-configuration"],
    });
  });

  it("binds both Fern index spellings in byte order", async () => {
    const root = await roots.create("docsfab-registry-fern-spellings-");
    await writeRelative(root, "fern/docs.yml", "navigation: []\n");
    await writeRelative(root, "fern/docs.yaml", "navigation: []\n");
    const applicability = await deriveDocumentationSourceApplicability(
      applicabilityInput(root, "fern/docs.yml"),
    );
    expect(applicability.roots[0]).toMatchObject({
      adapterId: "fern",
      configurationFiles: [{ path: "fern/docs.yaml" }, { path: "fern/docs.yml" }],
      limitations: [],
    });
  });

  it("validates a Jupyter Book root as plain Markdown and records its unchecked navigation", async () => {
    // Before (origin/main): `_toc.yml` was not configuration, so this book was a
    // plain-Markdown root and passed. 3311d7d7c refused it with
    // unsupported-jupyter-book-adapter; the fallback restores the pass and names
    // the table of contents it does not check.
    const root = await roots.create("docsfab-registry-jupyter-book-");
    await writeRelative(root, "_toc.yml", "format: jb-book\nroot: intro\n");
    await writeRelative(root, "intro.md", "# Intro\n\nSee [setup](setup.md).\n");
    await writeRelative(root, "setup.md", "# Setup\n");
    const applicability = await deriveDocumentationSourceApplicability(
      applicabilityInput(root, "intro.md"),
    );
    expect(applicability.roots).toEqual([
      expect.objectContaining({
        root: ".",
        adapterId: "jupyter-book",
        configurationFiles: [
          { path: "_toc.yml", sha256: digest("format: jb-book\nroot: intro\n") },
        ],
        navigationMode: "explicit",
        limitations: ["navigation-not-checked"],
      }),
    ]);
    await expect(
      validateSourceAwareStructuralDocumentation(root, applicability.changedPaths, applicability),
    ).resolves.toEqual(
      SOURCE_AWARE_STRUCTURAL_DOCUMENTATION_CHECK_IDS.map((id) => ({ id, status: "passed" })),
    );
  });

  it("still fails a broken link in a Jupyter Book root through the plain-Markdown checks", async () => {
    const root = await roots.create("docsfab-registry-jupyter-book-broken-");
    await writeRelative(root, "_toc.yml", "format: jb-book\nroot: intro\n");
    await writeRelative(root, "intro.md", "# Intro\n\nSee [setup](missing.md).\n");
    const applicability = await deriveDocumentationSourceApplicability(
      applicabilityInput(root, "intro.md"),
    );
    await expect(
      validateSourceAwareStructuralDocumentation(root, applicability.changedPaths, applicability),
    ).rejects.toMatchObject({ check: "documentation-relative-links", status: "failed" });
  });

  it("refuses a Jupyter Book root that does not record its unchecked navigation", async () => {
    const root = await roots.create("docsfab-registry-jupyter-book-unrecorded-");
    await writeRelative(root, "_toc.yml", "format: jb-book\nroot: intro\n");
    await writeRelative(root, "intro.md", "# Intro\n");
    const derived = await deriveDocumentationSourceApplicability(
      applicabilityInput(root, "intro.md"),
    );
    const forged = createDocumentationSourceApplicability({
      repositoryIdentitySha256: derived.repositoryIdentitySha256,
      baseRevision: derived.baseRevision,
      candidateInputTreeSha256: derived.candidateInputTreeSha256,
      changedPaths: derived.changedPaths,
      roots: derived.roots.map((item) => ({ ...item, limitations: [] })),
    });
    await expect(
      validateSourceAwareStructuralDocumentation(root, forged.changedPaths, forged),
    ).rejects.toMatchObject({ check: "documentation-source-applicability", status: "limitation" });
  });

  it("keeps a Sphinx root whose conf.py sits beside a sphinx-external-toc _toc.yml", async () => {
    // Sphinx validates natively, so it owns the root; `_toc.yml` alone would be
    // a Jupyter Book. Before this rule both bound and the root was ambiguous.
    for (const confPath of ["conf.py", "docs/conf.py"]) {
      const root = await roots.create("docsfab-registry-sphinx-external-toc-");
      await writeRelative(root, confPath, "project = 'Example'\n");
      await writeRelative(root, "_toc.yml", "format: jb-book\nroot: index\n");
      await writeRelative(root, "docs/index.md", "# Example\n");
      const applicability = await deriveDocumentationSourceApplicability(
        applicabilityInput(root, "docs/index.md"),
      );
      expect(applicability.roots[0], confPath).toMatchObject({
        adapterId: "sphinx",
        configurationFiles: [{ path: confPath }],
        limitations: [],
      });
    }
  });

  it("does not treat deleting a Jupyter Book table of contents as a validation downgrade", async () => {
    // The book was already checked as plain Markdown, as before it was registered.
    const root = await roots.create("docsfab-registry-jupyter-book-deleted-");
    await writeRelative(root, "intro.md", "# Intro\n");
    const applicability = await deriveDocumentationSourceApplicability({
      ...applicabilityInput(root, "_toc.yml", "deleted"),
      baseConfigurationPaths: ["_toc.yml"],
    });
    expect(applicability.roots).toEqual([
      expect.objectContaining({ adapterId: "plain-markdown", limitations: [] }),
    ]);
  });

  it("binds every Docusaurus module spelling alongside the sidebars it validates", async () => {
    // Before: only `.js` and `.ts` were configuration, so `docusaurus.config.mjs`
    // changed without changing the applicability digest.
    const root = await roots.create("docsfab-registry-docusaurus-mjs-");
    await writeRelative(root, "docusaurus.config.mjs", "export default {};\n");
    await writeRelative(root, "sidebars.js", "export default {docs: ['index']};\n");
    await writeRelative(root, "docs/index.md", "# Example\n");
    const applicability = await deriveDocumentationSourceApplicability(
      applicabilityInput(root, "docs/index.md"),
    );
    expect(applicability.roots[0]).toMatchObject({
      adapterId: "docusaurus",
      configurationFiles: [{ path: "docusaurus.config.mjs" }, { path: "sidebars.js" }],
      limitations: [],
    });
  });
});
