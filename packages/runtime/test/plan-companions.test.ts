// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Navigation companions on the plan binding, their producer, the post-write
 * reachability labels, and index link preservation, each against real files.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { REQUEST_INTENT_TARGET_ROLES } from "../src/request-intent/contract.js";
import {
  attachNavigationCompanions,
  bindDocumentationPlanProposal,
  createDocumentationPlanBinding,
  createSourceAwareDocumentationPlanBinding,
  DocumentationPlanBindingError,
  documentationPlanBindingDigest,
  documentationPlanBindingV2Digest,
  documentationPlanPagePaths,
  documentationPlanWritePaths,
  NAVIGATION_COMPANION_ROLES,
  validateAdmittedDocumentationPlanBinding,
  type DocumentationPageDisposition,
  type DocumentationPlanMode,
} from "../src/workflow-execution/plan-binding.js";
import {
  assertIndexLinksPreserved,
  documentationPlanCompanions,
  documentationReachabilityLabels,
  isNavigationLabelList,
  LOCAL_DOCUMENTATION_WRITE_ROOTS,
  NavigationCompanionLinkRemovedError,
  navigationLabelSummary,
  type NavigationLabelV1,
  observeDocumentationRoots,
  preservedIndexPaths,
  readIndexLinkBases,
} from "../src/workflow-execution/plan-companions.js";

const REVISION = "a".repeat(40);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspace(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "docsfab-plan-companions-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

function plan(
  mode: DocumentationPlanMode,
  pages: readonly { path: string; disposition: DocumentationPageDisposition }[],
) {
  const mutating = pages.filter(
    (page) => page.disposition !== "retain" && page.disposition !== "out-of-scope",
  );
  return createDocumentationPlanBinding(
    {
      mode,
      pages,
      sourceBindings: mutating.map((page) => ({
        pagePath: page.path,
        sources: mode === "update" ? ["docs/sdk.md"] : [`docs/sdk.md@${REVISION}`],
      })),
    },
    { expectedMode: mode },
  );
}

const SDK_PAGES = [
  { path: "docs/install.md", disposition: "move" },
  { path: "docs/sdk.md", disposition: "split" },
] as const;

/** Shaped like the pilot's metrics SDK: stubs that point back to the index. */
const METRICS_SDK = {
  "nav.json": '{"version":"2","items":[{"label":"SDK reference","path":"docs/index.md"}]}\n',
  "docs/index.md": "# SDK reference\n\n- [SDK](sdk.md)\n",
  "docs/sdk.md": "# SDK\n\nSee [the index](index.md).\n",
  "docs/install.md": "# Install\n\nMoved. See [the index](index.md).\n",
  "docs/client.md": "# Client\n\nMoved. See [the index](index.md).\n",
};

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function bindingError(run: () => unknown): DocumentationPlanBindingError {
  try {
    run();
  } catch (error) {
    if (error instanceof DocumentationPlanBindingError) return error;
    throw error;
  }
  throw new Error("Expected a documentation plan binding refusal, but the binding was admitted.");
}

describe("navigation companions on the plan binding", () => {
  it("keeps the digest of every companion-free binding sealed before companions existed", () => {
    const mode = "restructure" as const;
    const pages = [...SDK_PAGES];
    const sourceBindings = pages.map((page) => ({
      pagePath: page.path,
      sources: [`docs/sdk.md@${REVISION}`],
    }));
    // Computed by the origin/main plan binding before this change.
    expect(documentationPlanBindingDigest({ mode, pages, sourceBindings })).toBe(
      "fb5c0e213c47d8580c65e4167677e5f9b5a7d4db96af98dab5ca436455c1356e",
    );
    expect(
      documentationPlanBindingV2Digest({
        mode,
        pages,
        sourceBindings,
        sourceBindingSha256: "b".repeat(64),
      }),
    ).toBe("547f73aaeb462a0c851548dcc2640cc0fa6ec94676c001dd87fa6dd11fd3bff1");
    expect(
      documentationPlanBindingDigest({ mode, pages, sourceBindings, navigationCompanions: [] }),
    ).toBe("fb5c0e213c47d8580c65e4167677e5f9b5a7d4db96af98dab5ca436455c1356e");
  });

  it("names exactly the non-write request-intent roles", () => {
    expect([...NAVIGATION_COMPANION_ROLES].sort()).toEqual(
      REQUEST_INTENT_TARGET_ROLES.filter((role) => role !== "write").sort(),
    );
  });

  it("adds a companion to the write paths but never to the page paths, V1 and V2", () => {
    const companion = {
      path: "docs/index.md",
      role: "companion-index",
      baseSha256: "c".repeat(64),
    } as const;
    const v1 = plan("restructure", [...SDK_PAGES]);
    const v2 = createSourceAwareDocumentationPlanBinding(
      { mode: v1.mode, pages: v1.pages, sourceBindings: v1.sourceBindings },
      "d".repeat(64),
      { expectedMode: "restructure" },
    );
    for (const binding of [v1, v2]) {
      const attached = attachNavigationCompanions(binding, [companion]);
      expect(attached.navigationCompanions).toEqual([companion]);
      expect(attached.digest).not.toBe(binding.digest);
      expect(documentationPlanWritePaths(attached)).toEqual([
        "docs/index.md",
        "docs/install.md",
        "docs/sdk.md",
      ]);
      expect(documentationPlanPagePaths(attached)).toEqual(["docs/install.md", "docs/sdk.md"]);
      expect(validateAdmittedDocumentationPlanBinding(structuredClone(attached))).toEqual(attached);
      // Adjacent: no companion leaves the binding byte-identical.
      expect(attachNavigationCompanions(binding, [])).toBe(binding);
    }
  });

  it("refuses a companion on a fresh proposal, outside restructure mode, or on a page", () => {
    const companion = {
      path: "docs/index.md",
      role: "companion-index",
      baseSha256: "c".repeat(64),
    };
    const restructure = plan("restructure", [...SDK_PAGES]);
    const fresh = bindingError(() =>
      bindDocumentationPlanProposal({
        kind: restructure.kind,
        schemaVersion: restructure.schemaVersion,
        mode: restructure.mode,
        pages: restructure.pages,
        sourceBindings: restructure.sourceBindings,
        navigationCompanions: [companion],
      }),
    );
    expect([fresh.code, fresh.location]).toEqual(["invalid-shape", "$.navigationCompanions"]);

    const update = plan("update", [{ path: "docs/sdk.md", disposition: "update" }]);
    const updateBody = { ...update, navigationCompanions: [companion] };
    const outsideMode = bindingError(() =>
      validateAdmittedDocumentationPlanBinding({
        ...updateBody,
        digest: documentationPlanBindingDigest(updateBody),
      }),
    );
    expect([outsideMode.code, outsideMode.location]).toEqual([
      "invalid-shape",
      "$.navigationCompanions",
    ]);

    const onPage = {
      ...restructure,
      navigationCompanions: [{ ...companion, path: "docs/sdk.md" }],
    };
    const duplicate = bindingError(() =>
      validateAdmittedDocumentationPlanBinding({
        ...onPage,
        digest: documentationPlanBindingDigest(onPage),
      }),
    );
    expect([duplicate.code, duplicate.location]).toEqual([
      "duplicate-page",
      "$.navigationCompanions",
    ]);

    const empty = { ...restructure, navigationCompanions: [] };
    const emptyRefusal = bindingError(() =>
      validateAdmittedDocumentationPlanBinding({
        ...empty,
        digest: documentationPlanBindingDigest(empty),
      }),
    );
    expect([emptyRefusal.code, emptyRefusal.location]).toEqual([
      "invalid-shape",
      "$.navigationCompanions",
    ]);
    // Positive control: the same binding without the field admits.
    expect(validateAdmittedDocumentationPlanBinding(structuredClone(restructure))).toEqual(
      restructure,
    );
  });
});

describe("the navigation companion producer", () => {
  it("admits the docs-root index beside moved and split pages in the pilot shape", async () => {
    const root = await workspace(METRICS_SDK);
    const binding = plan("restructure", [...SDK_PAGES]);
    const observed = await observeDocumentationRoots({ workspacePath: root, plan: binding });
    expect(observed.navigation).toBeNull();
    const produced = documentationPlanCompanions(
      binding,
      observed,
      LOCAL_DOCUMENTATION_WRITE_ROOTS,
    );
    expect(produced).toEqual({
      companions: [
        {
          path: "docs/index.md",
          role: "companion-index",
          baseSha256: sha256(METRICS_SDK["docs/index.md"]),
        },
      ],
      labels: [],
    });
    // The pilot's root nav.json has no recognizer here: never a companion, never written.
    expect(produced.companions.map((companion) => companion.path)).not.toContain("nav.json");
  });

  it.each(["move", "merge", "split", "restructure"] as const)(
    "derives a companion for a %s page and none for retain or out-of-scope only",
    async (disposition) => {
      const root = await workspace(METRICS_SDK);
      const triggered = plan("restructure", [
        { path: "docs/client.md", disposition },
        { path: "docs/sdk.md", disposition: "retain" },
      ]);
      const observed = await observeDocumentationRoots({ workspacePath: root, plan: triggered });
      expect(
        documentationPlanCompanions(triggered, observed, LOCAL_DOCUMENTATION_WRITE_ROOTS)
          .companions,
      ).toHaveLength(1);

      const frozen = plan("restructure", [
        { path: "docs/client.md", disposition: "out-of-scope" },
        { path: "docs/sdk.md", disposition: "retain" },
      ]);
      const frozenObserved = await observeDocumentationRoots({ workspacePath: root, plan: frozen });
      expect(
        documentationPlanCompanions(frozen, frozenObserved, LOCAL_DOCUMENTATION_WRITE_ROOTS),
      ).toEqual({ companions: [], labels: [] });
    },
  );

  it("never widens an update or create plan", async () => {
    const root = await workspace(METRICS_SDK);
    for (const binding of [
      plan("update", [{ path: "docs/sdk.md", disposition: "update" }]),
      plan("create", [{ path: "docs/new.md", disposition: "create" }]),
    ]) {
      const observed = await observeDocumentationRoots({ workspacePath: root, plan: binding });
      expect(
        documentationPlanCompanions(binding, observed, LOCAL_DOCUMENTATION_WRITE_ROOTS),
      ).toEqual({ companions: [], labels: [] });
    }
  });

  it("keeps the planner's own index row instead of adding a companion", async () => {
    const root = await workspace(METRICS_SDK);
    const binding = plan("restructure", [
      ...SDK_PAGES,
      { path: "docs/index.md", disposition: "restructure" },
    ]);
    const observed = await observeDocumentationRoots({ workspacePath: root, plan: binding });
    expect(documentationPlanCompanions(binding, observed, LOCAL_DOCUMENTATION_WRITE_ROOTS)).toEqual(
      {
        companions: [],
        labels: [],
      },
    );
    // Preservation still applies to the planner-listed index.
    expect(preservedIndexPaths(binding, observed)).toEqual(["docs/index.md"]);
  });

  it("labels an index outside the grant instead of admitting it", async () => {
    const root = await workspace(METRICS_SDK);
    const binding = plan("restructure", [...SDK_PAGES]);
    const observed = await observeDocumentationRoots({ workspacePath: root, plan: binding });
    const ceiling = ["docs/sdk.md", "docs/install.md", "fern/docs.yml"];
    expect(documentationPlanCompanions(binding, observed, ceiling)).toEqual({
      companions: [],
      labels: [
        {
          code: "navigation-companion-not-granted",
          path: "docs/index.md",
          grant: [...ceiling].sort(),
        },
      ],
    });
    // Adjacent: a ceiling that covers the index admits it.
    expect(
      documentationPlanCompanions(binding, observed, ["docs/"]).companions.map((c) => c.path),
    ).toEqual(["docs/index.md"]);
  });

  it("labels a repository-root index the local roots do not grant", async () => {
    const root = await workspace({
      "README.md": "# Project\n\n[Guide](guide.md)\n",
      "guide.md": "# Guide\n",
      "docs/sdk.md": "# SDK\n",
    });
    const binding = plan("restructure", [{ path: "guide.md", disposition: "move" }]);
    const observed = await observeDocumentationRoots({ workspacePath: root, plan: binding });
    expect(observed.indexes.map((index) => index.path)).toEqual(["README.md"]);
    expect(documentationPlanCompanions(binding, observed, LOCAL_DOCUMENTATION_WRITE_ROOTS)).toEqual(
      {
        companions: [],
        labels: [
          {
            code: "navigation-companion-not-granted",
            path: "README.md",
            grant: ["docs/", "fern/"],
          },
        ],
      },
    );
  });

  it("labels an explicit MkDocs navigation once and never makes it a companion", async () => {
    const root = await workspace({
      "mkdocs.yml": "site_name: SDK\nnav:\n  - SDK: sdk.md\n",
      "docs/sdk.md": "# SDK\n",
      "docs/install.md": "# Install\n",
    });
    const binding = plan("restructure", [...SDK_PAGES]);
    const observed = await observeDocumentationRoots({ workspacePath: root, plan: binding });
    expect(observed.navigation).toEqual({
      path: "mkdocs.yml",
      mode: "explicit",
      entries: ["docs/sdk.md"],
    });
    const produced = documentationPlanCompanions(
      binding,
      observed,
      LOCAL_DOCUMENTATION_WRITE_ROOTS,
    );
    expect(produced.companions).toEqual([]);
    expect(produced.labels).toEqual([
      {
        code: "navigation-companion-not-granted",
        path: "mkdocs.yml",
        grant: ["docs/", "fern/"],
      },
    ]);
    // Even a grant that covers it never admits a navigation configuration file.
    expect(
      documentationPlanCompanions(binding, observed, ["mkdocs.yml", "docs/"]).companions,
    ).toEqual([]);
  });

  it("reads automatic MkDocs navigation as needing no companion label", async () => {
    const root = await workspace({
      "mkdocs.yml": "site_name: SDK\n",
      "docs/sdk.md": "# SDK\n",
      "docs/install.md": "# Install\n",
    });
    const binding = plan("restructure", [...SDK_PAGES]);
    const observed = await observeDocumentationRoots({ workspacePath: root, plan: binding });
    expect(observed.navigation).toEqual({ path: "mkdocs.yml", mode: "automatic" });
    expect(documentationPlanCompanions(binding, observed, LOCAL_DOCUMENTATION_WRITE_ROOTS)).toEqual(
      {
        companions: [],
        labels: [],
      },
    );
  });

  it("reads an index only as a regular file inside the workspace", async () => {
    const outside = await workspace({ "index.md": "# Outside\n" });
    const root = await workspace({ "docs/sdk.md": "# SDK\n", "docs/install.md": "# Install\n" });
    await symlink(join(outside, "index.md"), join(root, "docs/index.md"));
    const binding = plan("restructure", [...SDK_PAGES]);
    const observed = await observeDocumentationRoots({ workspacePath: root, plan: binding });
    expect(observed.indexes).toEqual([]);
  });

  it("reads no index through a directory link out of the workspace, but one inside it", async () => {
    const pages = { "index.md": "# Index\n", "sdk.md": "# SDK\n", "install.md": "# Install\n" };
    const outside = await workspace(pages);
    const escaped = await workspace({});
    await symlink(outside, join(escaped, "docs"));
    const binding = plan("restructure", [...SDK_PAGES]);
    expect(
      (await observeDocumentationRoots({ workspacePath: escaped, plan: binding })).indexes,
    ).toEqual([]);
    const inside = await workspace(
      Object.fromEntries(Object.entries(pages).map(([name, text]) => [`real/${name}`, text])),
    );
    await symlink(join(inside, "real"), join(inside, "docs"));
    expect(
      (await observeDocumentationRoots({ workspacePath: inside, plan: binding })).indexes,
    ).toEqual([{ path: "docs/index.md", sha256: sha256("# Index\n") }]);
  });
});

describe("post-write reachability labels", () => {
  async function labels(
    files: Record<string, string>,
    binding = plan("restructure", [...SDK_PAGES]),
    limits?: Parameters<typeof documentationReachabilityLabels>[0]["limits"],
  ) {
    const root = await workspace(files);
    return documentationReachabilityLabels({
      workspacePath: root,
      plan: binding,
      ...(limits ? { limits } : {}),
    });
  }

  it("labels one page with no link path, once, and passes a page two hops away", async () => {
    const result = await labels({
      "docs/index.md": "# Index\n\n[Guide](guide/)\n",
      "docs/guide/index.md": "# Guide\n\n[SDK](../sdk.md)\n",
      "docs/sdk.md": "# SDK\n",
      "docs/install.md": "# Install\n",
    });
    expect(result).toEqual([
      {
        code: "navigation-unreachable-page",
        path: "docs/install.md",
        navigation: null,
        index: "docs/index.md",
      },
    ]);
    expect(isNavigationLabelList(result)).toBe(true);
  });

  it("starts from a README index and from explicit MkDocs navigation", async () => {
    expect(
      await labels({
        "docs/README.md": "# Index\n\n[SDK](sdk.md) and [install](install)\n",
        "docs/sdk.md": "# SDK\n",
        "docs/install.md": "# Install\n",
      }),
    ).toEqual([]);
    expect(
      await labels({
        "mkdocs.yml": "site_name: SDK\nnav:\n  - SDK: sdk.md\n  - Install: install.md\n",
        "docs/sdk.md": "# SDK\n",
        "docs/install.md": "# Install\n",
      }),
    ).toEqual([]);
  });

  it("labels an unlinked CREATE page without widening the CREATE plan", async () => {
    const created = plan("create", [{ path: "docs/new.md", disposition: "create" }]);
    expect(
      await labels({ "docs/index.md": "# Index\n", "docs/new.md": "# New\n" }, created),
    ).toEqual([
      {
        code: "navigation-unreachable-page",
        path: "docs/new.md",
        navigation: null,
        index: "docs/index.md",
      },
    ]);
    expect(
      await labels(
        { "docs/index.md": "# Index\n\n[New](new.md)\n", "docs/new.md": "# New\n" },
        created,
      ),
    ).toEqual([]);
    expect(documentationPlanWritePaths(created)).toEqual(["docs/new.md"]);
  });

  it("counts automatic navigation as reaching every page", async () => {
    expect(
      await labels({
        "mkdocs.yml": "site_name: SDK\n",
        "docs/sdk.md": "# SDK\n",
        "docs/install.md": "# Install\n",
      }),
    ).toEqual([]);
  });

  it("prefers MkDocs navigation over a root _toc.yml when both are present", async () => {
    expect(
      await labels({
        "_toc.yml": "format: jb-book\nroot: intro\n",
        "mkdocs.yml": "site_name: SDK\nnav:\n  - SDK: sdk.md\n",
        "docs/index.md": "# Index\n",
        "docs/sdk.md": "# SDK\n",
      }),
    ).toEqual([]);
  });

  it("never labels an updated page, which was reachable or not before the run", async () => {
    expect(
      await labels(
        { "docs/index.md": "# Index\n", "docs/sdk.md": "# SDK\n" },
        plan("update", [{ path: "docs/sdk.md", disposition: "update" }]),
      ),
    ).toEqual([]);
  });

  it("labels a run with neither navigation nor an index as not checked, never as reachable", async () => {
    expect(await labels({ "docs/sdk.md": "# SDK\n", "docs/install.md": "# Install\n" })).toEqual([
      {
        code: "navigation-not-checked",
        path: null,
        reason: "no-navigation-or-index",
        navigation: null,
        limit: null,
      },
    ]);
  });

  it("labels navigation the check cannot read as not checked", async () => {
    expect(
      await labels({
        "sidebars.js": "module.exports = {};\n",
        "docs/index.md": "# Index\n",
        "docs/sdk.md": "# SDK\n",
        "docs/install.md": "# Install\n",
      }),
    ).toEqual([
      {
        code: "navigation-not-checked",
        path: null,
        reason: "navigation-unread",
        navigation: "sidebars.js",
        limit: null,
      },
    ]);
  });

  it("passes at the traversal bound and labels one node over it with the limit", async () => {
    const files = {
      "docs/index.md": "# Index\n\n[SDK](sdk.md)\n",
      "docs/sdk.md": "# SDK\n\n[Install](install.md)\n",
      "docs/install.md": "# Install\n",
    };
    const at = { environment: { DOCSFAB_REPOSITORY_INVENTORY_MAX_ENTRIES: "3" } };
    const over = { environment: { DOCSFAB_REPOSITORY_INVENTORY_MAX_ENTRIES: "2" } };
    expect(await labels(files, undefined, at)).toEqual([]);
    expect(await labels(files, undefined, over)).toEqual([
      {
        code: "navigation-not-checked",
        path: null,
        reason: "limit-exceeded",
        navigation: null,
        limit: { name: "repository.inventoryMaxEntries", observed: 3, value: 2 },
      },
    ]);
  });
});

describe("the persisted navigation label", () => {
  const overrun = (limit: unknown, reason = "limit-exceeded") => ({
    code: "navigation-not-checked",
    path: null,
    reason,
    navigation: null,
    limit,
  });

  it("states the run's effective bound, not the catalog default", () => {
    const label = overrun({ name: "repository.inventoryMaxEntries", observed: 3, value: 2 });
    expect(isNavigationLabelList([label])).toBe(true);
    expect(navigationLabelSummary(label as NavigationLabelV1)).toContain(
      "3 exceeds repository.inventoryMaxEntries = 2 count.",
    );
  });

  it.each([
    [
      "an uncatalogued limit name",
      overrun({ name: "repository.renamedLimit", observed: 5, value: 4 }),
    ],
    ["an inherited property as a name", overrun({ name: "toString", observed: 5, value: 4 })],
    ["a limit without its value", overrun({ name: "repository.inventoryMaxEntries", observed: 3 })],
    [
      "a limit whose value is not an integer",
      overrun({ name: "repository.inventoryMaxEntries", observed: 3, value: "2" }),
    ],
    ["a limit-exceeded reason without a limit", overrun(null)],
    [
      "a limit on another reason",
      overrun(
        { name: "repository.inventoryMaxEntries", observed: 3, value: 2 },
        "navigation-unread",
      ),
    ],
  ])("refuses %s", (_case, label) => {
    expect(isNavigationLabelList([label])).toBe(false);
  });
});

describe("index link preservation", () => {
  const INDEX = "# Index\n\n- [SDK](sdk.md)\n- [Client](client.md)\n";

  async function preserve(after: string | null) {
    const root = await workspace({ "docs/index.md": INDEX });
    const bases = await readIndexLinkBases({ workspacePath: root, paths: ["docs/index.md"] });
    expect(bases.get("docs/index.md")).toEqual(["docs/client.md", "docs/sdk.md"]);
    if (after === null) await rm(join(root, "docs/index.md"));
    else await writeFile(join(root, "docs/index.md"), after);
    return assertIndexLinksPreserved({ workspacePath: root, bases });
  }

  it("admits an edit that adds and reorders links", async () => {
    await expect(
      preserve(
        "# Index\n\n- [Install](install.md)\n- [Client](./client.md)\n- [SDK](sdk.md#top)\n",
      ),
    ).resolves.toBeUndefined();
  });

  it.each([
    ["removes", "# Index\n\n- [SDK](sdk.md)\n", ["docs/client.md"]],
    ["retargets", "# Index\n\n- [SDK](sdk.md)\n- [Client](client-v2.md)\n", ["docs/client.md"]],
    ["deletes", null, ["docs/client.md", "docs/sdk.md"]],
  ] as const)("refuses an edit that %s an existing link", async (_case, after, removed) => {
    const error = await preserve(after).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NavigationCompanionLinkRemovedError);
    expect(error).toMatchObject({
      code: "navigation-companion-link-removed",
      path: "docs/index.md",
      removed,
    });
  });

  it("names only removed targets that pass the plan path grammar", async () => {
    const root = await workspace({
      "docs/index.md": "# Index\n\n- [SDK](sdk.md)\n- [Odd](l%0Am.md)\n- [Space](a%20b.md)\n",
    });
    const bases = await readIndexLinkBases({ workspacePath: root, paths: ["docs/index.md"] });
    await writeFile(join(root, "docs/index.md"), "# Index\n");
    const error = await assertIndexLinksPreserved({ workspacePath: root, bases }).catch(
      (caught: unknown) => caught as Error,
    );
    expect(error).toBeInstanceOf(NavigationCompanionLinkRemovedError);
    expect(error.message).toContain("drops 3 existing link target(s) (docs/sdk.md, 2 not shown).");
    expect(error.message).not.toContain("\n");
  });
});
