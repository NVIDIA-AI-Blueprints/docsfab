// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildContentIndex } from "../src/content-ir/index.js";
import { LocalImpactPostflightService } from "../src/impact/postflight.js";
import { GitPatchEvidenceCollector } from "../src/repository/evidence.js";

export interface registerImpactPostflightScenariosInputs {
  readonly poisonRelativePath: string;
  readonly poisonMarkdown: string;
}

export function registerImpactPostflightScenarios(
  inputs: registerImpactPostflightScenariosInputs,
): void {
  describe("LocalImpactPostflightService", () => {
    const roots: string[] = [];
    const collectors: GitPatchEvidenceCollector[] = [];

    afterEach(async () => {
      await Promise.all(collectors.splice(0).map((collector) => collector.dispose()));
      await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    });

    it("analyzes a mutated disposable workspace at the same immutable Git revision", async () => {
      const workspacePath = await mkdtemp(join(tmpdir(), "docsfab-impact-postflight-"));
      roots.push(workspacePath);
      const revision = "a".repeat(40);
      await writeFile(join(workspacePath, "README.md"), "# Before\n");
      const before = await buildContentIndex({
        repositoryPath: workspacePath,
        repositoryRevision: revision,
      });
      const service = new LocalImpactPostflightService(before);

      await writeFile(join(workspacePath, "README.md"), "# After\n\nChanged body.\n");
      const result = await service.postflight({
        runId: "run-same-revision",
        workflow: "bootstrap",
        workspacePath,
        repository: {
          sourcePath: "/selected/source",
          requestedRevision: "HEAD",
          revision,
        },
        changedFiles: [],
      });

      expect(result).toEqual({
        schemaVersion: 1,
        status: "completed",
        analysisDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        changedPaths: ["README.md"],
      });
    });

    it("rejects a run whose revision differs from the captured baseline", async () => {
      const workspacePath = await mkdtemp(join(tmpdir(), "docsfab-impact-postflight-"));
      roots.push(workspacePath);
      const revision = "a".repeat(40);
      await writeFile(join(workspacePath, "README.md"), "# Stable\n");
      const before = await buildContentIndex({
        repositoryPath: workspacePath,
        repositoryRevision: revision,
      });

      await expect(
        new LocalImpactPostflightService(before).postflight({
          runId: "run-stale-revision",
          workflow: "bootstrap",
          workspacePath,
          repository: {
            sourcePath: "/selected/source",
            requestedRevision: "HEAD",
            revision: "b".repeat(40),
          },
          changedFiles: [],
        }),
      ).rejects.toThrow("baseline revision");
    });

    it("reindexes the same includePaths so nested invalid fixtures stay unwalked", async () => {
      const workspacePath = await mkdtemp(join(tmpdir(), "docsfab-impact-postflight-roots-"));
      roots.push(workspacePath);
      const revision = "a".repeat(40);
      const poison = join(workspacePath, inputs.poisonRelativePath);
      await mkdir(join(workspacePath, "docs"), { recursive: true });
      await mkdir(poison, { recursive: true });
      await writeFile(join(workspacePath, "docs", "page.md"), "# Before\n");
      await writeFile(join(poison, "index.md"), inputs.poisonMarkdown);
      const includePaths = ["docs"];
      const before = await buildContentIndex({
        repositoryPath: workspacePath,
        repositoryRevision: revision,
        includePaths,
      });
      await writeFile(join(workspacePath, "docs", "page.md"), "# After\n\nChanged body.\n");
      const result = await new LocalImpactPostflightService(before, { includePaths }).postflight({
        runId: "run-bounded-roots",
        workflow: "create-documentation",
        workspacePath,
        repository: {
          sourcePath: "/selected/source",
          requestedRevision: "HEAD",
          revision,
        },
        changedFiles: [],
      });
      expect(result.status).toBe("completed");
      expect(result).toMatchObject({ changedPaths: ["docs/page.md"] });
    });

    it("reports a navigation-only change in a no-Git workspace from source-bound evidence", async () => {
      const workspacePath = await mkdtemp(join(tmpdir(), "docsfab-impact-postflight-export-"));
      roots.push(workspacePath);
      const revision = "a".repeat(40);
      await writeFile(join(workspacePath, "guide.md"), "# Before\n\nOne.\n\nTwo.\n");
      await writeFile(join(workspacePath, "navigation.yml"), "pages: [guide.md]\n");
      const collector = await GitPatchEvidenceCollector.create(
        workspacePath,
        join(workspacePath, "artifacts"),
      );
      collectors.push(collector);
      await expect(access(join(workspacePath, ".git"))).rejects.toThrow();
      const before = await buildContentIndex({
        repositoryPath: workspacePath,
        repositoryRevision: revision,
      });
      const service = new LocalImpactPostflightService(before);
      await writeFile(join(workspacePath, "navigation.yml"), "pages: [renamed.md]\n");
      const changes = await collector.capture({
        runId: "run-navigation-only",
        workspacePath,
        repository: { sourcePath: "/selected/source", requestedRevision: "HEAD", revision },
        persistPatch: false,
      });
      expect(changes.files).toEqual([{ path: "navigation.yml", status: "modified" }]);
      const result = await service.postflight({
        runId: "run-navigation-only",
        workflow: "create-documentation",
        workspacePath,
        repository: { sourcePath: workspacePath, requestedRevision: "HEAD", revision },
        changedFiles: changes.files,
      });
      expect(result).toMatchObject({ status: "completed", changedPaths: ["navigation.yml"] });
    });

    it("reports mixed content and navigation changes with both sides of a rename", async () => {
      const workspacePath = await mkdtemp(join(tmpdir(), "docsfab-impact-postflight-export-"));
      roots.push(workspacePath);
      const revision = "a".repeat(40);
      await writeFile(join(workspacePath, "guide.md"), "# Before\n\nOne.\n\nTwo.\n");
      await writeFile(join(workspacePath, "navigation.yml"), "pages: [guide.md]\n");
      const collector = await GitPatchEvidenceCollector.create(
        workspacePath,
        join(workspacePath, "artifacts"),
      );
      collectors.push(collector);
      await expect(access(join(workspacePath, ".git"))).rejects.toThrow();
      const before = await buildContentIndex({
        repositoryPath: workspacePath,
        repositoryRevision: revision,
      });
      await writeFile(join(workspacePath, "renamed.md"), "# After\n\nOne.\n\nTwo.\n");
      await rm(join(workspacePath, "guide.md"));
      await writeFile(join(workspacePath, "navigation.yml"), "pages: [renamed.md]\n");
      const changes = await collector.capture({
        runId: "run-navigation-rename",
        workspacePath,
        repository: { sourcePath: "/selected/source", requestedRevision: "HEAD", revision },
        persistPatch: false,
      });
      expect(changes.files).toEqual([
        { path: "navigation.yml", status: "modified" },
        { path: "renamed.md", previousPath: "guide.md", status: "renamed" },
      ]);
      const result = await new LocalImpactPostflightService(before).postflight({
        runId: "run-navigation-rename",
        workflow: "create-documentation",
        workspacePath,
        repository: { sourcePath: "/selected/source", requestedRevision: "HEAD", revision },
        changedFiles: changes.files,
      });
      expect(result).toMatchObject({
        status: "completed",
        changedPaths: ["guide.md", "navigation.yml", "renamed.md"],
      });
    });

    it("emits an MDX page and fern/versions/nightly.yml in changedPaths", async () => {
      const workspacePath = await mkdtemp(join(tmpdir(), "docsfab-impact-postflight-nightly-"));
      roots.push(workspacePath);
      const revision = "a".repeat(40);
      await mkdir(join(workspacePath, "docs"), { recursive: true });
      await mkdir(join(workspacePath, "fern/versions"), { recursive: true });
      await writeFile(join(workspacePath, "docs/guide.mdx"), "# Before\n\nIntro.\n");
      await writeFile(
        join(workspacePath, "fern/versions/nightly.yml"),
        "versions:\n  - docs/guide.mdx\n",
      );
      const collector = await GitPatchEvidenceCollector.create(
        workspacePath,
        join(workspacePath, "artifacts"),
      );
      collectors.push(collector);
      await expect(access(join(workspacePath, ".git"))).rejects.toThrow();
      const before = await buildContentIndex({
        repositoryPath: workspacePath,
        repositoryRevision: revision,
      });
      await writeFile(join(workspacePath, "docs/guide.mdx"), "# After\n\nUpdated body.\n");
      await writeFile(
        join(workspacePath, "fern/versions/nightly.yml"),
        "versions:\n  - docs/guide.mdx\n  - docs/extra.mdx\n",
      );
      const changes = await collector.capture({
        runId: "run-page-plus-nightly",
        workspacePath,
        repository: { sourcePath: "/selected/source", requestedRevision: "HEAD", revision },
        persistPatch: false,
      });
      expect(changes.files).toEqual([
        { path: "docs/guide.mdx", status: "modified" },
        { path: "fern/versions/nightly.yml", status: "modified" },
      ]);
      const result = await new LocalImpactPostflightService(before).postflight({
        runId: "run-page-plus-nightly",
        workflow: "create-documentation",
        workspacePath,
        repository: { sourcePath: "/selected/source", requestedRevision: "HEAD", revision },
        changedFiles: changes.files,
      });
      expect(result).toMatchObject({
        status: "completed",
        changedPaths: ["docs/guide.mdx", "fern/versions/nightly.yml"],
      });
    });
  });
}
