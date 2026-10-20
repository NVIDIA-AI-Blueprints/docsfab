// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  classifyProjectConfigCheckout,
  inspectProjectConfigCheckout,
  loadTrackedDocsFabProjectConfig,
  PROJECT_CONFIG_UNTRACKED_CODE,
  ProjectConfigPreflightError,
  projectConfigPreflightNextStep,
  REPOSITORY_SOURCE_DIRTY_CODE,
  resolveProjectConfigAuthority,
} from "../src/project-config-preflight.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import { readTrackedRepositoryFile } from "../src/repository/workspace/tracked-read.js";
import { temporaryRoots } from "./helpers/temp.js";
import { commitFixture, initFixtureRepo } from "./helpers/git.js";

const temporary = temporaryRoots();

const PROJECT_CONFIG = `${JSON.stringify({
  schemaVersion: 1,
  gitlab: { remote: "origin", defaultBranch: "main" },
  provider: { configuration: "host" },
  storage: { scope: "user-private" },
})}\n`;

describe("shared project-config preflight", () => {
  it("classifies untracked .docsfab.json without treating it as other dirty porcelain", () => {
    const inspection = classifyProjectConfigCheckout({
      porcelain: "?? .docsfab.json\n",
      trackedInRevision: false,
      projectConfigPresent: true,
    });
    expect(inspection.codes).toEqual([PROJECT_CONFIG_UNTRACKED_CODE]);
  });

  it("classifies non-config dirty porcelain as repository-source-dirty", () => {
    const inspection = classifyProjectConfigCheckout({
      porcelain: " M README.md\n",
      trackedInRevision: true,
      projectConfigPresent: true,
    });
    expect(inspection.codes).toEqual([REPOSITORY_SOURCE_DIRTY_CODE]);
  });

  it("emits mode-specific next steps for the same codes", () => {
    expect(projectConfigPreflightNextStep(PROJECT_CONFIG_UNTRACKED_CODE, "auto")).toContain(
      "docsfab auto --dry-run",
    );
    expect(
      projectConfigPreflightNextStep(PROJECT_CONFIG_UNTRACKED_CODE, "multi-unit-campaign"),
    ).toContain("docsfab multi-unit-campaign");
    expect(projectConfigPreflightNextStep(PROJECT_CONFIG_UNTRACKED_CODE, "run")).toContain(
      "Remove the untracked",
    );
    expect(projectConfigPreflightNextStep(PROJECT_CONFIG_UNTRACKED_CODE, "publish")).toContain(
      "docsfab publish --execute",
    );
    expect(
      projectConfigPreflightNextStep(REPOSITORY_SOURCE_DIRTY_CODE, "multi-unit-campaign"),
    ).toBe("git status; then retry docsfab multi-unit-campaign");
  });

  it("inspects an untracked .docsfab.json checkout as project-config-untracked", async () => {
    const repository = await gitRepository();
    await writeFile(join(repository, ".docsfab.json"), PROJECT_CONFIG, { mode: 0o600 });
    const inspection = await inspectProjectConfigCheckout(repository);
    expect(inspection.codes).toEqual([PROJECT_CONFIG_UNTRACKED_CODE]);
    expect(inspection.trackedInRevision).toBe(false);
    expect(inspection.projectConfigPresent).toBe(true);
  });

  it("inspects dirty non-config porcelain as repository-source-dirty", async () => {
    const repository = await gitRepository({ trackedConfig: true });
    await writeFile(join(repository, "README.md"), "# dirty\n");
    const inspection = await inspectProjectConfigCheckout(repository);
    expect(inspection.codes).toEqual([REPOSITORY_SOURCE_DIRTY_CODE]);
    expect(inspection.codes).not.toContain(PROJECT_CONFIG_UNTRACKED_CODE);
  });

  it("surfaces project-config-untracked on the release-documentation-readiness preflight", async () => {
    const repository = await gitRepository();
    await writeFile(join(repository, ".docsfab.json"), PROJECT_CONFIG, { mode: 0o600 });
    const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
    try {
      await expect(
        loadTrackedDocsFabProjectConfig({
          sourcePath: workspace.sourcePath,
          readTrackedBytes: () => readTrackedRepositoryFile(workspace, ".docsfab.json", 8 * 1024),
          surface: "release-documentation-readiness",
        }),
      ).rejects.toMatchObject({
        name: "ProjectConfigPreflightError",
        code: PROJECT_CONFIG_UNTRACKED_CODE,
      } satisfies Partial<ProjectConfigPreflightError>);
    } finally {
      await workspace.dispose();
    }
  });

  it("keeps the legacy release-doc sentence together with the shared code", async () => {
    const repository = await gitRepository();
    await writeFile(join(repository, ".docsfab.json"), PROJECT_CONFIG, { mode: 0o600 });
    const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
    try {
      await expect(
        loadTrackedDocsFabProjectConfig({
          sourcePath: workspace.sourcePath,
          readTrackedBytes: () => readTrackedRepositoryFile(workspace, ".docsfab.json", 8 * 1024),
          surface: "release-documentation-readiness",
        }),
      ).rejects.toThrow(
        /requires a valid tracked \.docsfab\.json[\s\S]*Code: project-config-untracked/u,
      );
    } finally {
      await workspace.dispose();
    }
  });

  it("resolves missing, untracked, valid tracked, and invalid tracked authority", async () => {
    const missing = await gitRepository();
    await expect(resolveProjectConfigAuthority(missing)).resolves.toEqual({ status: "missing" });

    const untracked = await gitRepository();
    await writeFile(join(untracked, ".docsfab.json"), PROJECT_CONFIG, { mode: 0o600 });
    await expect(resolveProjectConfigAuthority(untracked)).resolves.toMatchObject({
      status: "untracked",
    });

    const tracked = await gitRepository({ trackedConfig: true });
    await expect(resolveProjectConfigAuthority(tracked)).resolves.toEqual({
      status: "tracked",
      config: {
        schemaVersion: 1,
        gitlab: { remote: "origin", defaultBranch: "main" },
        provider: { configuration: "host" },
        storage: { scope: "user-private" },
      },
    });

    const invalid = await gitRepository();
    await writeFile(join(invalid, ".docsfab.json"), "{not-valid}\n", { mode: 0o600 });
    await commitFixture(invalid, "invalid");
    await expect(resolveProjectConfigAuthority(invalid)).rejects.toThrow(
      "Existing DocsFab project configuration is invalid",
    );
  });

  it("refuses a tracked .docsfab.json that still carries the deleted execution key, naming the fix", async () => {
    const retired = await gitRepository({
      trackedConfig: true,
      extraKeys: { execution: { level: "production" } },
    });
    await expect(resolveProjectConfigAuthority(retired)).rejects.toThrow(UNREAD_KEY_REFUSAL);
    // The key and its value never reach the message.
    await expect(resolveProjectConfigAuthority(retired)).rejects.not.toThrow(
      /execution|production/u,
    );

    // Adjacent condition: only known keys, one invalid value, keeps the generic refusal.
    const invalidValue = await gitRepository({
      trackedConfig: true,
      extraKeys: { storage: { scope: "shared" } },
    });
    await expect(resolveProjectConfigAuthority(invalidValue)).rejects.toThrow(
      "Existing DocsFab project configuration is invalid; no project file was changed.",
    );

    // Positive control: the same file without the key is tracked authority.
    const valid = await gitRepository({ trackedConfig: true });
    await expect(resolveProjectConfigAuthority(valid)).resolves.toMatchObject({
      status: "tracked",
    });
  });
});

const UNREAD_KEY_REFUSAL =
  "Existing DocsFab project configuration has a top-level key DocsFab does not read; keep only schemaVersion, gitlab, provider, storage, and documentationRoots in .docsfab.json, then retry. No project file was changed.";

async function gitRepository(
  options: { trackedConfig?: boolean; extraKeys?: Record<string, unknown> } = {},
): Promise<string> {
  const root = await temporary.create("docsfab-project-config-preflight-");
  if (options.trackedConfig) {
    const projectConfig = JSON.parse(PROJECT_CONFIG) as Record<string, unknown>;
    Object.assign(projectConfig, options.extraKeys ?? {});
    await writeFile(join(root, ".docsfab.json"), `${JSON.stringify(projectConfig)}\n`, {
      mode: 0o600,
    });
    await chmod(join(root, ".docsfab.json"), 0o600);
  }
  await initFixtureRepo(root, { "README.md": "# fixture\n" }, { branch: "main" });
  return root;
}
