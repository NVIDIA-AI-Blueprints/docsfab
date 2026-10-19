// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A `documentationRoots` entry that the revision tracks as a regular file is a
 * file root: it grants exactly that file, letter case included, and nothing
 * beside it, and the file skips the documentation-directory check a page
 * under a directory root meets. Source, CI, hidden, third-party, and agent
 * instruction files stay refused even when listed. An entry not known to be a
 * tracked file is never a file root.
 */
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  documentationPlanWriteScope,
  droppedDocumentationRootsStatus,
  DocumentationRootsOutsideWriteRootsError,
  firstPassDocumentationWriteRoots,
} from "../src/cli/first-pass.js";
import {
  describeDroppedDocumentationRoots,
  documentationFileRootRule,
  documentationRstUpdatePathRule,
  documentationWriteTargetRule,
} from "../src/cli/first-pass-support.js";
import {
  createFirstRunProposalScopeBinding,
  FirstRunProposalScopeError,
  proposalScopeFailureCode,
  rejectDocumentationTargets,
} from "../src/init/first-run-bootstrap.js";
import { DocumentationScope } from "../src/live-agent/documentation-scope.js";
import { trackedHeadRegularFiles } from "../src/project-config-preflight.js";
import { buildRequestIntentPromptInventory } from "../src/request-intent/interpret-inventory.js";
import { resolvePromptInventoryLimits } from "../src/request-intent/interpret-inventory.js";
import { intersectWriteCeilings } from "../src/workflow-execution/plan-companions.js";
import { commitFixture, git, initFixtureRepo } from "./helpers/git.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** The DR-2 shape: every documentation root is a tracked README-style file. */
const DR2 = ["README.md", "RELEASE.md", "demo/x/README.md", "tests/bats/README.md"];

/** The benchmark's DR-2 workspace configuration, all eight entries tracked files. */
const DR2_WORKSPACE = [
  "README.md",
  "RELEASE.md",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  "demo/clusters/openshift/README.md",
  "demo/specs/quickstart/README.md",
  "demo/specs/selectors/README.md",
  "tests/bats/README.md",
];

describe("resolving documentationRoots into directory and file roots", () => {
  it("grants each tracked file exactly, without a trailing slash", () => {
    expect(firstPassDocumentationWriteRoots(DR2, "local-widen", DR2)).toEqual({
      roots: ["README.md", "RELEASE.md", "demo/x/README.md", "tests/bats/README.md"],
      dropped: [],
    });
    // A directory beside a file keeps its slash: the DD-2 shape.
    expect(
      firstPassDocumentationWriteRoots(
        ["fern/versions/latest/pages", "packages/config/README.md"],
        "local-widen",
        ["packages/config/README.md"],
      ),
    ).toEqual({
      roots: ["fern/versions/latest/pages/", "packages/config/README.md"],
      dropped: [],
    });
  });

  it("makes every entry of the benchmark's DR-2 configuration writable as exactly that file", () => {
    const resolved = firstPassDocumentationWriteRoots(DR2_WORKSPACE, "local-widen", DR2_WORKSPACE);
    expect(resolved).toEqual({ roots: [...DR2_WORKSPACE].sort(), dropped: [] });
    for (const path of DR2_WORKSPACE) {
      expect(
        documentationWriteTargetRule(path, resolved.roots, "local-widen"),
        path,
      ).toBeUndefined();
    }
    for (const path of [
      "SECURITY.md",
      "README.md.bak",
      "README.md/x.md",
      "contributing.md",
      "demo/specs/quickstart/other.md",
      "tests/bats/readme.md",
    ]) {
      expect(documentationWriteTargetRule(path, resolved.roots, "local-widen"), path).toBeDefined();
    }
  });

  it("never makes a file root of an entry not known to be a tracked file", () => {
    // Unknown state stays confined: the entry is a directory, so the file is not granted.
    const unknown = firstPassDocumentationWriteRoots(["README.md"], "local-widen");
    expect(unknown.roots).toEqual(["README.md/"]);
    expect(documentationWriteTargetRule("README.md", unknown.roots, "local-widen")).toBe(
      "configured-roots",
    );
    // A listed file the revision does not track is no file root either.
    const untracked = firstPassDocumentationWriteRoots(["NOTES.md"], "local-widen", ["README.md"]);
    expect(untracked.roots).toEqual(["NOTES.md/"]);
  });

  it("keeps source, CI, hidden, third-party, agent instruction, and non-page files refused", () => {
    const listed = [
      "README.md",
      "src/README.md",
      ".github/README.md",
      "vendor/lib/README.md",
      "node_modules/pkg/README.md",
      ".docsfab/reference-model/notes.md",
      "AGENTS.md",
      "CLAUDE.md",
      "docs/AGENTS.md",
      "skills/x/SKILL.md",
      "Makefile",
      "README.rst",
      "docs/index.MDX",
    ];
    const resolved = firstPassDocumentationWriteRoots(listed, "local-widen", listed);
    expect(resolved.roots).toEqual(["README.md"]);
    expect(resolved.dropped).toEqual(listed.slice(1));
    expect(
      describeDroppedDocumentationRoots(["src/README.md", "Makefile"], "local-widen", listed),
    ).toBe(
      '"src/README.md" (a hidden, third-party, source, CI, or agent instruction file), "Makefile" (a file that is not a Markdown or MDX page)',
    );
  });

  it("keeps a file root under docs/ or fern/ under the narrow policy, and drops one outside", () => {
    expect(
      firstPassDocumentationWriteRoots(["docs/api.md", "README.md"], "narrow", [
        "docs/api.md",
        "README.md",
      ]),
    ).toEqual({ roots: ["docs/api.md"], dropped: ["README.md"] });
    expect(describeDroppedDocumentationRoots(["README.md"], "narrow", ["README.md"])).toBe(
      '"README.md" (outside docs/ and fern/)',
    );
  });

  it("admits only tracked RST update file roots that pass the shared protected-file policy", () => {
    for (const [path, policy, expected] of [
      ["docs/guide.rst", "narrow", undefined],
      ["site/content/guide.rst", "local-widen", undefined],
      ["guide.rst", "local-widen", undefined],
      ["guide.rst", "narrow", "write-roots"],
      ["docs/vendor/guide.rst", "narrow", "protected-path"],
      ["docs/node_modules/guide.rst", "narrow", "protected-path"],
      ["site/content/Vendor/guide.rst", "local-widen", "protected-path"],
      ["site/content/node_modules/guide.rst", "local-widen", "protected-path"],
      ["src/guide.rst", "local-widen", "protected-path"],
    ] as const) {
      expect(documentationRstUpdatePathRule(path, policy), path).toBe(expected);
      const resolved = firstPassDocumentationWriteRoots([path], policy, [path], [path]);
      expect(resolved.roots, path).toEqual(expected === undefined ? [path] : []);
      expect(resolved.dropped, path).toEqual(expected === undefined ? [] : [path]);
    }
  });

  it("names the file roots left in the dropped-roots status line", () => {
    expect(
      droppedDocumentationRootsStatus(
        "update-documentation",
        ["README.md", "AGENTS.md", "site/content"],
        "local-widen",
        ["README.md", "AGENTS.md"],
      ),
    ).toBe(
      'documentationRoots entries in .docsfab.json that grant no write root: "AGENTS.md" (a hidden, third-party, source, CI, or agent instruction file); named and new pages go only under site/content/, and named pages also to README.md',
    );
    expect(
      droppedDocumentationRootsStatus("update-documentation", ["README.md", "src"], "local-widen", [
        "README.md",
      ]),
    ).toBe(
      'documentationRoots entries in .docsfab.json that grant no write root: "src" (a code directory); only README.md can be written',
    );
  });

  it("refuses a create whose roots are all files, before any page can be bound", () => {
    const error = new DocumentationRootsOutsideWriteRootsError([], "local-widen", {
      fileRoots: ["README.md"],
    });
    expect(error.code).toBe("documentation-roots-outside-write-roots");
    expect(error.message).toMatch(
      /^A create writes a new page, which only a documentation directory can hold, and every documentationRoots entry in \.docsfab\.json that grants a write is a file: README\.md\. A file root grants only that file\. /u,
    );
    expect(error.message).not.toContain("Dropped:");
  });
});

describe("the documentation write rule under a file root", () => {
  const resolved = firstPassDocumentationWriteRoots([...DR2, "docs"], "local-widen", DR2).roots;

  it.each(DR2)("admits the file root %s itself", (path) => {
    expect(documentationWriteTargetRule(path, resolved, "local-widen")).toBeUndefined();
  });

  it.each([
    ["a sibling at the root", "CONTRIBUTING.md", "configured-roots"],
    ["a sibling in a file root's directory", "demo/x/OTHER.md", "configured-roots"],
    ["a sibling under tests/", "tests/bats/other.md", "configured-roots"],
    ["a longer name the root is a prefix of", "README.md.md", "configured-roots"],
    ["a page under the root as if it were a directory", "README.md/x.md", "configured-roots"],
    ["a non-page name the root is a prefix of", "README.md.bak", "page-path"],
    ["a letter-case variant", "readme.md", "configured-roots"],
    ["another letter-case variant", "Readme.md", "configured-roots"],
    ["a case variant of a nested root", "tests/bats/readme.md", "configured-roots"],
  ])("refuses %s, %s", (_name, path, rule) => {
    expect(documentationWriteTargetRule(path, resolved, "local-widen")).toBe(rule);
  });

  it("keeps the directory root beside the file roots", () => {
    expect(documentationWriteTargetRule("docs/guide.md", resolved, "local-widen")).toBeUndefined();
  });

  it.each([
    ["README.md", undefined],
    ["tests/bats/README.md", undefined],
    ["internal/README.md", undefined],
    ["src/README.md", "protected-path"],
    ["packages/x/src/README.md", "protected-path"],
    [".github/README.md", "protected-path"],
    ["docs/.hidden/README.md", "protected-path"],
    ["vendor/x/README.md", "protected-path"],
    ["AGENTS.md", "protected-path"],
    ["docs/CLAUDE.md", "protected-path"],
    ["README.rst", "page-path"],
    ["docs/../README.md", "page-path"],
  ] as const)("judges a tracked file %s as a file root: %s", (path, rule) => {
    expect(documentationFileRootRule(path, "local-widen")).toBe(rule);
  });

  it("names, for each refused plan write, whether a root could ever hold it", () => {
    const scope = documentationPlanWriteScope(["README.md", "docs"], "local-widen", ["README.md"]);
    expect(scope.roots).toEqual(["README.md", "docs/"]);
    expect(scope.rule("README.md")).toBeUndefined();
    expect(scope.rule("docs/guide.md")).toBeUndefined();
    // A page some root could hold, outside these roots.
    expect(scope.rule("CONTRIBUTING.md")).toBe("outside-roots");
    expect(scope.rule("site/content/a.md")).toBe("outside-roots");
    // A file no root admits, wherever it sits.
    expect(scope.rule("AGENTS.md")).toBe("protected");
    expect(scope.rule("src/notes.md")).toBe("protected");
    expect(scope.rule("docs/open-api/owners.yaml")).toBe("not-a-page");
    expect(
      documentationPlanWriteScope(["site/content"], "local-widen").rule("site/content/AGENTS.md"),
    ).toBe("protected");
  });

  it("refuses protected RST segments under otherwise admitted directory roots", () => {
    for (const [root, policy, path] of [
      ["docs", "narrow", "docs/vendor/page.rst"],
      ["docs", "narrow", "docs/node_modules/page.rst"],
      ["site/content", "local-widen", "site/content/Vendor/page.rst"],
      ["site/content", "local-widen", "site/content/node_modules/page.rst"],
    ] as const) {
      const scope = documentationPlanWriteScope([root], policy, [], undefined, [path]);
      expect(scope.rule(path), path).toBe("protected");
    }
    expect(
      documentationPlanWriteScope(["docs"], "narrow", [], undefined, ["docs/guide.rst"]).rule(
        "docs/guide.rst",
      ),
    ).toBeUndefined();
    expect(
      documentationPlanWriteScope(["guide.rst"], "local-widen", ["guide.rst"], undefined, [
        "guide.rst",
      ]).rule("guide.rst"),
    ).toBeUndefined();
  });
});

describe("the named-page refusal and the sealed scope grammar with file roots", () => {
  it("names a file root in the configured-roots sentence, and the code stays recoverable", () => {
    let thrown: unknown;
    try {
      rejectDocumentationTargets(
        [{ path: "notes/a.md", rule: "configured-roots" }],
        ["README.md", "RELEASE.md", "docs/"],
        {},
        "local-widen",
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(FirstRunProposalScopeError);
    const message = (thrown as Error).message;
    expect(message).toBe(
      "DocsFab cannot write notes/a.md: a named page must be under docs/, or be README.md or RELEASE.md, the documentationRoots in .docsfab.json. To write pages in another documentation directory, list it in documentationRoots in .docsfab.json.",
    );
    expect(proposalScopeFailureCode(message)).toBe("proposal-scope-unsafe-target");
  });

  it("seals a proposal scope that names file-root pages and still refuses a protected one", () => {
    const binding = (targetPaths: readonly string[]) =>
      createFirstRunProposalScopeBinding({
        workflow: "update-documentation",
        instructionSha256: "a".repeat(64),
        repositoryRevision: "b".repeat(40),
        targetPaths,
      });
    expect(binding(DR2).targetPaths).toEqual([...DR2].sort());
    for (const path of ["AGENTS.md", "src/notes.md", "docs/open-api/owners.yaml"]) {
      expect(() => binding([path]), path).toThrow(FirstRunProposalScopeError);
    }
  });
});

describe("the request interpretation lists a file root's page, and only it", () => {
  it("lists README.md under a README.md file root, but not a longer name", async () => {
    const entries = ["README.md", "README.md.md", "docs/a.md", "other.md"].map((path) => ({
      path,
      kind: "regular",
      byteLength: 10,
    }));
    const inventory = await buildRequestIntentPromptInventory({
      entries,
      readTrackedBytes: async () => new TextEncoder().encode("# Title\n"),
      docsRoots: ["README.md", "docs/"],
      limits: resolvePromptInventoryLimits(),
    });
    expect(inventory.entries.map((entry) => entry.path)).toEqual(["README.md", "docs/a.md"]);
  });
});

describe("a write ceiling intersection for navigation companions", () => {
  it("keeps only what both ceilings cover", () => {
    expect(intersectWriteCeilings(["docs/", "fern/"], ["docs/"])).toEqual(["docs/"]);
    expect(intersectWriteCeilings(["docs/", "fern/"], ["docs/guides/", "README.md"])).toEqual([
      "docs/guides/",
    ]);
    expect(intersectWriteCeilings(["docs/", "fern/"], ["docs/index.md", "site/"])).toEqual([
      "docs/index.md",
    ]);
    expect(intersectWriteCeilings(["docs/", "fern/"], ["site/content/"])).toEqual([]);
  });
});

describe("the live agent's documentation scope with file roots", () => {
  it("grants a configured file root exactly, and refuses its prefixes and case variants", () => {
    const scope = new DocumentationScope([], [], ["RELEASE.md", "demo/x/README.md"]);
    expect(scope.allows("RELEASE.md")).toBe(true);
    expect(scope.allows("demo/x/README.md")).toBe(true);
    for (const path of ["RELEASE.md.md", "RELEASE.md/x.md", "release.md", "demo/x/OTHER.md"]) {
      expect(scope.allows(path), path).toBe(false);
    }
    expect(scope.describe()).toContain("RELEASE.md (.docsfab.json, UTF-8 text editing)");
  });

  it.each(["AGENTS.md", "src/README.md", ".github/README.md"])(
    "refuses %s as a configured file root",
    (path) => {
      expect(() => new DocumentationScope([], [], [path])).toThrow(
        "documentationRoots in .docsfab.json may name only safe documentation directories and tracked text files.",
      );
    },
  );

  it("admits an unfamiliar configured text-file root without labeling it Markdown", () => {
    const scope = new DocumentationScope([], [], ["Makefile"]);
    expect(scope.allows("Makefile")).toBe(true);
    expect(scope.describe()).toContain("Makefile (.docsfab.json, UTF-8 text editing)");
    expect(scope.describe()).not.toContain("Makefile (Markdown)");
  });
});

describe("reading which configured roots HEAD tracks as regular files", () => {
  it("lists only exact-path regular files, never a directory, link, untracked file, or pattern", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-file-roots-head-"));
    roots.push(root);
    await initFixtureRepo(
      root,
      {
        "README.md": "# Readme\n",
        "docs/a.md": "# A\n",
        "tests/bats/README.md": "# Bats\n",
        "run.sh": "#!/bin/sh\n",
      },
      { branch: "main" },
    );
    await chmod(join(root, "run.sh"), 0o755);
    await symlink("README.md", join(root, "link.md"));
    await commitFixture(root, "link and mode");
    await mkdir(join(root, "untracked"), { recursive: true });
    await writeFile(join(root, "untracked.md"), "# Untracked\n");
    expect(await git(root, ["ls-files", "-s", "run.sh"])).toMatch(/^100755 /u);
    expect(
      await trackedHeadRegularFiles(root, [
        "README.md",
        "readme.md",
        "docs",
        "tests/bats/README.md",
        "link.md",
        "untracked.md",
        "run.sh",
        ":(glob)*.md",
        "*.md",
      ]),
    ).toEqual(["README.md", "tests/bats/README.md", "run.sh"]);
  });
});
