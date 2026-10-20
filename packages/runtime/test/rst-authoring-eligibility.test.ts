// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  eligibleRstUpdatePaths,
  rstConfigurationCandidates,
} from "../src/rst-authoring/eligibility.js";

const page = "docs/sub/page.rst";
const regular = (paths: readonly string[]) => paths.map((path) => ({ path, kind: "regular" }));

describe("RST exact-page configuration ownership", () => {
  it.each([
    ["docs/sub/conf.py", "docs/sub"],
    ["docs/conf.py", "docs"],
    ["conf.py", ""],
  ])("admits an exact nested page owned by %s", (configurationPath, documentationRoot) => {
    const candidates = rstConfigurationCandidates(page, page);
    expect(candidates).toContainEqual({
      configurationPath,
      documentationRoot,
      adapterId: "sphinx",
    });
    expect(eligibleRstUpdatePaths(regular([page, configurationPath]), [page])).toEqual([page]);
  });

  it("refuses competing ancestor configurations, including other adapter types", () => {
    for (const other of [
      "docs/mkdocs.yml",
      "mkdocs.yml",
      "docs/_toc.yml",
      "docs/sub/docusaurus.config.js",
      "docs/sub/conf.py",
    ]) {
      expect(eligibleRstUpdatePaths(regular([page, "docs/conf.py", other]), [page])).toEqual([]);
    }
  });

  it("does not count an untracked or symlinked configuration as an owner", () => {
    expect(eligibleRstUpdatePaths(regular([page]), [page])).toEqual([]);
    expect(
      eligibleRstUpdatePaths(
        [
          { path: page, kind: "regular" },
          { path: "docs/conf.py", kind: "symlink" },
        ],
        [page],
      ),
    ).toEqual([]);
  });

  it("keeps directory-root ownership scoped to its configured locations", () => {
    expect(eligibleRstUpdatePaths(regular([page, "docs/conf.py"]), ["docs/"])).toEqual([page]);
    expect(eligibleRstUpdatePaths(regular([page, "docs/sub/conf.py"]), ["docs/"])).toEqual([]);
  });

  it.each(["docs/sub/conf.py", "docs/sub/mkdocs.yml", "docs/sub/_toc.yml"])(
    "refuses a nested page with competing %s while admitting an unambiguous sibling",
    (nestedConfiguration) => {
      const sibling = "docs/other.rst";
      expect(
        eligibleRstUpdatePaths(regular([page, sibling, "docs/conf.py", nestedConfiguration]), [
          "docs/",
        ]),
      ).toEqual([sibling]);
    },
  );

  it("keeps repository-root Sphinx ownership for unambiguous directory pages", () => {
    const sibling = "docs/other.rst";
    expect(eligibleRstUpdatePaths(regular([page, sibling, "conf.py"]), ["docs/"])).toEqual([
      sibling,
      page,
    ]);
    expect(
      eligibleRstUpdatePaths(regular([page, sibling, "conf.py", "docs/sub/conf.py"]), ["docs/"]),
    ).toEqual([sibling]);
  });

  it("refuses a selected nested directory with an additional ancestor owner", () => {
    expect(
      eligibleRstUpdatePaths(regular([page, "docs/sub/conf.py", "docs/conf.py"]), ["docs/sub/"]),
    ).toEqual([]);
  });
});
