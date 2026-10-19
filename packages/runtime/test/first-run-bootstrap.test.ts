// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  bootstrapMissingProjectConfigIntoWorkspace,
  writeProvisionalProjectConfig,
} from "../src/init.js";
import {
  assertFirstRunProposalScopeBinding,
  createFirstRunProposalScopeBinding,
  FirstRunProposalScopeError,
  type FirstRunProposalScopeBinding,
} from "../src/init/first-run-bootstrap.js";
import { GitPatchEvidenceCollector } from "../src/repository/evidence.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import { temporaryRoots } from "./helpers/temp.js";
import { git, initFixtureRepo } from "./helpers/git.js";

const temporary = temporaryRoots();

const PROJECT_CONFIG = {
  schemaVersion: 1 as const,
  gitlab: { remote: "origin", defaultBranch: "main" },
  provider: { configuration: "host" as const },
  storage: { scope: "user-private" as const },
};

describe("first-run project configuration bootstrap", () => {
  it("keeps an unconfigured local write local in a repository without a remote", async () => {
    const repository = await gitRepositoryWithOrigin({ remote: false });
    const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
    try {
      await expect(
        bootstrapMissingProjectConfigIntoWorkspace({
          sourcePath: workspace.sourcePath,
          workspacePath: workspace.path,
          allowWrite: true,
          writeCapable: true,
          allowLocalUnconfigured: true,
        }),
      ).resolves.toEqual({ status: "local-unconfigured" });
      await expect(readFile(join(workspace.path, ".docsfab.json"))).rejects.toThrow();
      expect(await git(repository, ["remote"])).toBe("");
    } finally {
      await workspace.dispose();
    }
  });

  it("does not trust untracked config or skip tracked config validation for a local write", async () => {
    const repository = await gitRepositoryWithOrigin({ remote: false });
    await writeFile(join(repository, ".docsfab.json"), '{"documentationRoots":["private"]}\n');
    const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
    try {
      await expect(
        bootstrapMissingProjectConfigIntoWorkspace({
          sourcePath: workspace.sourcePath,
          workspacePath: workspace.path,
          allowWrite: true,
          writeCapable: true,
          allowLocalUnconfigured: true,
        }),
      ).resolves.toEqual({ status: "local-unconfigured" });
      await expect(readFile(join(workspace.path, ".docsfab.json"))).rejects.toThrow();
    } finally {
      await workspace.dispose();
    }

    const tracked = await gitRepositoryWithOrigin({ remote: false, trackedConfig: true });
    const trackedWorkspace = await prepareRepositoryWorkspace(tracked, "HEAD");
    try {
      await expect(
        bootstrapMissingProjectConfigIntoWorkspace({
          sourcePath: trackedWorkspace.sourcePath,
          workspacePath: trackedWorkspace.path,
          allowWrite: true,
          writeCapable: true,
          allowLocalUnconfigured: true,
        }),
      ).resolves.toEqual({ status: "tracked", config: PROJECT_CONFIG });
    } finally {
      await trackedWorkspace.dispose();
    }

    const invalid = await gitRepositoryWithOrigin({ remote: false, invalidTrackedConfig: true });
    const invalidWorkspace = await prepareRepositoryWorkspace(invalid, "HEAD");
    try {
      await expect(
        bootstrapMissingProjectConfigIntoWorkspace({
          sourcePath: invalidWorkspace.sourcePath,
          workspacePath: invalidWorkspace.path,
          allowWrite: true,
          writeCapable: true,
          allowLocalUnconfigured: true,
        }),
      ).rejects.toThrow("invalid");
    } finally {
      await invalidWorkspace.dispose();
    }
  });

  it("preserves setup gates for publication, explicit config, and required export", async () => {
    const repository = await gitRepositoryWithOrigin({ remote: false });
    const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
    try {
      for (const scope of [
        undefined,
        proposalScope(workspace.revision, [".docsfab.json", "docs/a.md"]),
      ]) {
        await expect(
          bootstrapMissingProjectConfigIntoWorkspace({
            sourcePath: workspace.sourcePath,
            workspacePath: workspace.path,
            allowWrite: true,
            writeCapable: true,
            allowLocalUnconfigured: scope !== undefined,
            ...(scope
              ? { proposalScope: scope, proposalScopeExpected: proposalScopeExpected(scope) }
              : {}),
          }),
        ).rejects.toMatchObject({ code: "no-supported-gitlab-remote" });
      }
      const scope = proposalScope(workspace.revision, ["docs/a.md"]);
      await expect(
        bootstrapMissingProjectConfigIntoWorkspace({
          sourcePath: workspace.sourcePath,
          workspacePath: workspace.path,
          allowWrite: true,
          writeCapable: true,
          allowLocalUnconfigured: true,
          proposalScope: scope,
          proposalScopeExpected: proposalScopeExpected(scope),
          requireExportedProjectConfig: true,
        }),
      ).rejects.toMatchObject({ code: "no-supported-gitlab-remote" });
      await expect(readFile(join(workspace.path, ".docsfab.json"))).rejects.toThrow();
    } finally {
      await workspace.dispose();
    }
  });

  it("writes a host-derived .docsfab.json into the workspace after the evidence baseline", async () => {
    const repository = await gitRepositoryWithOrigin();
    const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
    const artifacts = await temporary.create("docsfab-first-run-artifacts-");
    const collector = await GitPatchEvidenceCollector.create(workspace.path, artifacts);
    try {
      const result = await bootstrapMissingProjectConfigIntoWorkspace({
        sourcePath: workspace.sourcePath,
        workspacePath: workspace.path,
        allowWrite: true,
        writeCapable: true,
      });
      expect(result.status).toBe("bootstrapped");
      if (result.status !== "bootstrapped") throw new Error("expected bootstrap");
      expect(result.projectConfig).toEqual(PROJECT_CONFIG);
      const written = JSON.parse(
        await readFile(join(workspace.path, ".docsfab.json"), "utf8"),
      ) as unknown;
      expect(written).toEqual(PROJECT_CONFIG);
      await writeFile(join(workspace.path, "docs", "guide.md"), "# Guide\n");
      const evidence = await collector.capture({
        runId: "run-1",
        persistPatch: true,
        workspacePath: workspace.path,
        repository: {
          sourcePath: workspace.sourcePath,
          requestedRevision: "HEAD",
          revision: workspace.revision,
        },
      });
      expect(evidence.files).toEqual(
        expect.arrayContaining([
          { path: ".docsfab.json", status: "added" },
          { path: "docs/guide.md", status: "added" },
        ]),
      );
      expect(evidence.patch?.artifactPath).toBeDefined();
      const patch = await readFile(evidence.patch!.artifactPath, "utf8");
      expect(patch).toContain(".docsfab.json");
      expect(patch).toContain("docs/guide.md");
    } finally {
      await collector.dispose();
      await workspace.dispose();
    }
  });

  it("uses valid tracked config and does not mint a second project file", async () => {
    const repository = await gitRepositoryWithOrigin({ trackedConfig: true });
    const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
    try {
      const result = await bootstrapMissingProjectConfigIntoWorkspace({
        sourcePath: workspace.sourcePath,
        workspacePath: workspace.path,
        allowWrite: true,
        writeCapable: true,
      });
      expect(result).toEqual({ status: "tracked", config: PROJECT_CONFIG });
    } finally {
      await workspace.dispose();
    }
  });

  it("proposes host-derived config into the workspace when source config is untracked", async () => {
    const repository = await gitRepositoryWithOrigin();
    await writeFile(join(repository, ".docsfab.json"), `${JSON.stringify(PROJECT_CONFIG)}\n`, {
      mode: 0o600,
    });
    const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
    try {
      const result = await bootstrapMissingProjectConfigIntoWorkspace({
        sourcePath: workspace.sourcePath,
        workspacePath: workspace.path,
        allowWrite: true,
        writeCapable: true,
      });
      expect(result.status).toBe("bootstrapped");
      if (result.status !== "bootstrapped") throw new Error("expected bootstrap");
      expect(result.projectConfig).toEqual(PROJECT_CONFIG);
      const written = JSON.parse(
        await readFile(join(workspace.path, ".docsfab.json"), "utf8"),
      ) as unknown;
      expect(written).toEqual(PROJECT_CONFIG);
    } finally {
      await workspace.dispose();
    }
  });

  it("keeps derived setup host-private when an explicit proposal scope excludes config", async () => {
    const repository = await gitRepositoryWithOrigin();
    await writeFile(join(repository, ".docsfab.json"), '{"untracked":"not-authority"}\n');
    const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
    try {
      const scope = proposalScope(workspace.revision, ["docs/usage.md"]);
      const result = await bootstrapMissingProjectConfigIntoWorkspace({
        sourcePath: workspace.sourcePath,
        workspacePath: workspace.path,
        allowWrite: true,
        writeCapable: true,
        proposalScope: scope,
        proposalScopeExpected: proposalScopeExpected(scope),
      });
      expect(result.status).toBe("host-private");
      if (result.status !== "host-private") throw new Error("expected host-private setup");
      expect(result.projectConfig).toEqual(PROJECT_CONFIG);
      expect(scope.targetPaths).toEqual(["docs/usage.md"]);
      await expect(readFile(join(workspace.path, ".docsfab.json"))).rejects.toThrow();
      expect(await git(repository, ["status", "--short"])).toBe("?? .docsfab.json");
    } finally {
      await workspace.dispose();
    }
  });

  it("still rejects invalid tracked config before applying a proposal scope", async () => {
    const repository = await gitRepositoryWithOrigin({ invalidTrackedConfig: true });
    const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
    try {
      const scope = proposalScope(workspace.revision, ["docs/a.md", "docs/b.md"]);
      await expect(
        bootstrapMissingProjectConfigIntoWorkspace({
          sourcePath: workspace.sourcePath,
          workspacePath: workspace.path,
          allowWrite: true,
          writeCapable: true,
          proposalScope: scope,
          proposalScopeExpected: proposalScopeExpected(scope),
        }),
      ).rejects.toThrow("invalid");
      await expect(readFile(join(workspace.path, ".docsfab.json"), "utf8")).resolves.toBe(
        '{"schemaVersion":2}\n',
      );
    } finally {
      await workspace.dispose();
    }
  });

  it("exports config only when the explicit proposal scope names it", async () => {
    const repository = await gitRepositoryWithOrigin();
    const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
    try {
      const scope = proposalScope(workspace.revision, [".docsfab.json", "docs/a.md", "docs/b.md"]);
      const result = await bootstrapMissingProjectConfigIntoWorkspace({
        sourcePath: workspace.sourcePath,
        workspacePath: workspace.path,
        allowWrite: true,
        writeCapable: true,
        proposalScope: scope,
        proposalScopeExpected: proposalScopeExpected(scope),
      });
      expect(result.status).toBe("bootstrapped");
      expect(JSON.parse(await readFile(join(workspace.path, ".docsfab.json"), "utf8"))).toEqual(
        PROJECT_CONFIG,
      );
    } finally {
      await workspace.dispose();
    }
  });

  it("rejects invalid, drifted, and config-required proposal scopes before writing", async () => {
    expect(() => proposalScope("f".repeat(40), ["docs/a.md", "docs/a.md"])).toThrowError(
      expect.objectContaining<Partial<FirstRunProposalScopeError>>({
        code: "proposal-scope-input-invalid",
      }),
    );
    for (const unsafePath of [
      "../unsafe.md",
      "docs/../escape.md",
      "docs/.../escape.md",
      "fern/./escape.md",
    ]) {
      expect(() => proposalScope("f".repeat(40), [unsafePath, "docs/a.md"])).toThrowError(
        expect.objectContaining<Partial<FirstRunProposalScopeError>>({
          code: "proposal-scope-input-invalid",
        }),
      );
    }

    const repository = await gitRepositoryWithOrigin();
    const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
    try {
      const scope = proposalScope(workspace.revision, ["docs/a.md", "docs/b.md"]);
      const tamperedScope = {
        ...scope,
        targetPaths: [".docsfab.json", ...scope.targetPaths],
      } as FirstRunProposalScopeBinding;
      await expect(
        bootstrapMissingProjectConfigIntoWorkspace({
          sourcePath: workspace.sourcePath,
          workspacePath: workspace.path,
          allowWrite: true,
          writeCapable: true,
          proposalScope: tamperedScope,
          proposalScopeExpected: proposalScopeExpected(scope),
        }),
      ).rejects.toMatchObject({ code: "proposal-scope-binding-mismatch" });
      await expect(readFile(join(workspace.path, ".docsfab.json"))).rejects.toThrow();

      await expect(
        bootstrapMissingProjectConfigIntoWorkspace({
          sourcePath: workspace.sourcePath,
          workspacePath: workspace.path,
          allowWrite: true,
          writeCapable: true,
          proposalScope: scope,
          proposalScopeExpected: {
            ...proposalScopeExpected(scope),
            repositoryRevision: "e".repeat(40),
          },
        }),
      ).rejects.toMatchObject({ code: "proposal-scope-binding-mismatch" });
      await expect(readFile(join(workspace.path, ".docsfab.json"))).rejects.toThrow();

      await expect(
        bootstrapMissingProjectConfigIntoWorkspace({
          sourcePath: workspace.sourcePath,
          workspacePath: workspace.path,
          allowWrite: true,
          writeCapable: true,
          proposalScope: scope,
          proposalScopeExpected: proposalScopeExpected(scope),
          requireExportedProjectConfig: true,
        }),
      ).rejects.toMatchObject({ code: "proposal-scope-excludes-project-config" });
      await expect(readFile(join(workspace.path, ".docsfab.json"))).rejects.toThrow();
    } finally {
      await workspace.dispose();
    }
  });

  it("requires migration for a proposal scope with a different sealed schema version", () => {
    const scope = proposalScope("f".repeat(40), ["docs/a.md", "docs/b.md"]);
    expect(() =>
      assertFirstRunProposalScopeBinding(
        { ...scope, schemaVersion: 2 } as unknown as FirstRunProposalScopeBinding,
        proposalScopeExpected(scope),
      ),
    ).toThrowError(expect.objectContaining({ code: "migration-required" }));
  });

  it("skips bootstrap for read-only runs even when config is missing", async () => {
    const repository = await gitRepositoryWithOrigin();
    const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
    try {
      await expect(
        bootstrapMissingProjectConfigIntoWorkspace({
          sourcePath: workspace.sourcePath,
          workspacePath: workspace.path,
          allowWrite: false,
          writeCapable: true,
          allowLocalUnconfigured: true,
        }),
      ).resolves.toEqual({ status: "skipped" });
      await expect(
        bootstrapMissingProjectConfigIntoWorkspace({
          sourcePath: workspace.sourcePath,
          workspacePath: workspace.path,
          allowWrite: true,
          writeCapable: false,
          allowLocalUnconfigured: true,
        }),
      ).resolves.toEqual({ status: "skipped" });
    } finally {
      await workspace.dispose();
    }
  });

  it("refuses to overwrite a workspace that already has a project file", async () => {
    const root = await temporary.create("docsfab-first-run-existing-");
    await writeFile(join(root, ".docsfab.json"), `${JSON.stringify(PROJECT_CONFIG)}\n`);
    await expect(writeProvisionalProjectConfig(root, PROJECT_CONFIG)).rejects.toThrow(
      "refusing to mint a provisional file",
    );
  });
});

async function gitRepositoryWithOrigin(
  options: { trackedConfig?: boolean; invalidTrackedConfig?: boolean; remote?: boolean } = {},
): Promise<string> {
  const root = await temporary.create("docsfab-first-run-");
  if (options.invalidTrackedConfig) {
    await writeFile(join(root, ".docsfab.json"), '{"schemaVersion":2}\n', { mode: 0o600 });
  } else if (options.trackedConfig) {
    await writeFile(join(root, ".docsfab.json"), `${JSON.stringify(PROJECT_CONFIG)}\n`, {
      mode: 0o600,
    });
  }
  await initFixtureRepo(
    root,
    { "README.md": "# fixture\n", "docs/intro.md": "# Intro\n" },
    { branch: "main" },
  );
  if (options.remote !== false) {
    await git(root, ["remote", "add", "origin", "ssh://git@gitlab.example.test/group/docs.git"]);
    await git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    await git(root, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  }
  return root;
}

function proposalScope(
  repositoryRevision: string,
  targetPaths: readonly string[],
): FirstRunProposalScopeBinding {
  return createFirstRunProposalScopeBinding({
    workflow: "update-documentation",
    instructionSha256: "a".repeat(64),
    repositoryRevision,
    targetPaths,
  });
}

function proposalScopeExpected(scope: FirstRunProposalScopeBinding) {
  return {
    workflow: scope.workflow,
    instructionSha256: scope.instructionSha256,
    repositoryRevision: scope.repositoryRevision,
  };
}
