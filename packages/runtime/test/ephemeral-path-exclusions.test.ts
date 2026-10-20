// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { buildContentIndex, EXCLUDED_DIRECTORIES } from "../src/content-ir/indexer.js";
import {
  prepareStandardSiteBootstrapChecks,
  standardSiteBootstrapCheckPolicy,
} from "../src/site-bootstrap/policy.js";
import { runRepositoryChecks } from "../src/templates/checks.js";
import { temporaryRoots } from "./helpers/temp.js";

const REVISION = "a".repeat(40);
const roots = temporaryRoots();
const repoGitignore = resolve(dirname(fileURLToPath(import.meta.url)), "../../../.gitignore");

describe("ephemeral path exclusions", () => {
  it("keeps the private-state directory in indexer and site-bootstrap skip sets", () => {
    expect(EXCLUDED_DIRECTORIES.has(".docsfab")).toBe(true);
    const script = standardSiteBootstrapCheckPolicy().checks[0]?.args[1];
    expect(script).toContain("'.docsfab'");
  });

  it("does not index markdown under the private-state directory", async () => {
    const root = await roots.create("docsfab-ephemeral-index-");
    await writeFile(join(root, "keep.md"), "# Keep\n", "utf8");
    await mkdir(join(root, ".docsfab"));
    await writeFile(join(root, ".docsfab", "hidden.md"), "# Hidden docsfab\n", "utf8");
    const index = await buildContentIndex({
      repositoryPath: root,
      repositoryRevision: REVISION,
    });
    const documents = index.nodes
      .filter((node) => node.kind === "document")
      .map((node) => node.sourcePath);
    expect(documents).toEqual(["keep.md"]);
  });

  it("skips invalid UTF-8 under the private-state directory during site-bootstrap checks", async () => {
    const root = await roots.create("docsfab-ephemeral-policy-");
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "docs", "index.md"), "# Documentation\n", "utf8");
    await mkdir(join(root, ".docsfab"));
    await writeFile(join(root, ".docsfab", "hidden.md"), Buffer.from([0xff]));
    const report = await runRepositoryChecks({
      workspacePath: root,
      capability: await prepareStandardSiteBootstrapChecks(),
    });
    expect(report.status).toBe("passed");
  });

  it("ignores the ephemeral probe names in the repository gitignore", async () => {
    const gitignore = await readFile(repoGitignore, "utf8");
    expect(gitignore).toContain(".docsfab-rollback-*");
    expect(gitignore).toContain(".docsfab-validation-probe");
    expect(gitignore).toContain(".docsfab-write-probe");
  });
});
