// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CREATE onto a path the repository revision already holds: the collision
 * oracle reads the exact revision export and marks the one shape an UPDATE can
 * start from; every other shape is refused by name, and candidate
 * reconstruction keeps its own check behind plan admission.
 */
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { classifyThrownFailure } from "../src/operator/failure-classification.js";
import { GitPatchEvidenceCollector } from "../src/repository/evidence.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import {
  admitAuthorizedTrackedWrites,
  trackedRepositoryBlobObjectId,
} from "../src/repository/workspace/tracked-read.js";
import {
  plannedTargetCollisions,
  prepareAuthoringRevisionWorkspace,
  reconstructionTargetCollision,
  sealAuthoringCandidate,
  writePlannedOutput,
} from "../src/workflow-execution/authoring-workspace-host.js";
import { CreateTargetExistsError } from "../src/workflow-execution/plan-binding.js";
import { initFixtureRepo } from "./helpers/git.js";
import { temporaryRoots } from "./helpers/temp.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

const temporary = temporaryRoots();
/**
 * A case that seals candidate 0 and exports the revision again, or exports a
 * multi-MiB page: about 1.5 s alone, and several times that on a loaded
 * shared host.
 */
const EXPORT_CASE_LOCAL_MS = 20_000;
const SOURCE = "src/source.ts";
const EXISTING_PAGE = "docs/routing/guide.md";
const STUB = "# Routing guide stub\n";
const STUB_SHA256 = createHash("sha256").update(STUB).digest("hex");

/** `git hash-object` of `text` in the fixture repository's SHA-1 object format. */
function gitBlobObjectId(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}

/** Whether this host's temporary file system folds letter case, as macOS does by default. */
const caseInsensitiveHost = await (async () => {
  const probe = join(tmpdir(), `docsfab-case-probe-${process.pid}-${Date.now()}`);
  await writeFile(probe, "");
  try {
    return await lstat(probe.toUpperCase()).then(
      () => true,
      () => false,
    );
  } finally {
    await rm(probe, { force: true });
  }
})();

async function fixtureWorkspace(extra: Record<string, string> = {}) {
  const source = await temporary.create("docsfab-create-target-source-");
  const revision = await initFixtureRepo(
    source,
    {
      "README.md": "# Fixture\n",
      [SOURCE]: "export const truth = 'source truth';\n",
      [EXISTING_PAGE]: STUB,
      ...extra,
    },
    { branch: "main" },
  );
  const workspace = await prepareRepositoryWorkspace(source, revision);
  return { source, revision, workspace };
}

describe("CREATE target collisions at candidate reconstruction", () => {
  it("names a file, a directory, and a file at an ancestor before any directory is created", async () => {
    const root = await temporary.create("docsfab-create-target-child-");
    await mkdir(join(root, "docs/routing"), { recursive: true });
    await writeFile(join(root, "docs/routing/guide.md"), "# Stub\n");
    await writeFile(join(root, "README.md"), "# Fixture\n");

    await expect(reconstructionTargetCollision(root, "docs/routing/new.md")).resolves.toBe(
      undefined,
    );
    await expect(reconstructionTargetCollision(root, "docs/fresh/new.md")).resolves.toBe(undefined);
    await expect(reconstructionTargetCollision(root, EXISTING_PAGE)).resolves.toEqual({
      path: EXISTING_PAGE,
      existing: "file",
    });
    await expect(reconstructionTargetCollision(root, "docs/routing")).resolves.toEqual({
      path: "docs/routing",
      existing: "directory",
    });
    await expect(reconstructionTargetCollision(root, "README.md/child.md")).resolves.toEqual({
      path: "README.md/child.md",
      existing: "parent-file",
    });
    // The check created nothing on the way.
    await expect(lstat(join(root, "docs/fresh"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a file at an ancestor by code before creating any directory", async () => {
    const root = await temporary.create("docsfab-create-target-write-");
    await writeFile(join(root, "README.md"), "# Fixture\n");

    const refusal = await writePlannedOutput(root, "README.md/child.md", Buffer.from("x")).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(CreateTargetExistsError);
    expect(refusal).toMatchObject({
      code: "create-target-exists",
      scope: "candidate-reconstruction",
      collisions: [{ path: "README.md/child.md", existing: "parent-file" }],
    });
    // Positive control: a new path under new directories is written.
    const written = await writePlannedOutput(root, "docs/new/page.md", Buffer.from("# Page\n"));
    await expect(readFile(written, "utf8")).resolves.toBe("# Page\n");
  });
});

describe("CREATE target collisions at the run's revision", () => {
  it("admits paths the revision does not hold (positive control)", async () => {
    const { workspace } = await fixtureWorkspace();
    try {
      await expect(
        plannedTargetCollisions(workspace, ["docs/routing/new-guide.md", "docs/new/index.md"]),
      ).resolves.toEqual([]);
    } finally {
      await workspace.dispose();
    }
  });

  it("names an existing file, a directory, and a path under a file", async () => {
    const { workspace } = await fixtureWorkspace();
    try {
      await expect(
        plannedTargetCollisions(workspace, [
          EXISTING_PAGE,
          "docs/routing",
          "README.md/child.md",
          "docs/routing/new-guide.md",
        ]),
      ).resolves.toEqual([
        { path: "README.md/child.md", existing: "parent-file" },
        { path: "docs/routing", existing: "directory" },
        // Only the exact tracked page carries the base an UPDATE starts from.
        { path: EXISTING_PAGE, existing: "file", base: { sha256: STUB_SHA256 } },
      ]);
    } finally {
      await workspace.dispose();
    }
  });

  it("matches a path that differs only in case, as a case-insensitive file system would", async () => {
    const { workspace } = await fixtureWorkspace();
    try {
      await expect(
        plannedTargetCollisions(workspace, ["Docs/Routing/Guide.md", "readme.md/child.md"]),
      ).resolves.toEqual([
        { path: "Docs/Routing/Guide.md", existing: "file" },
        { path: "readme.md/child.md", existing: "parent-file" },
      ]);
    } finally {
      await workspace.dispose();
    }
  });

  it("marks an existing page the run's write grant does not let it modify", async () => {
    const { workspace } = await fixtureWorkspace();
    const asked: { path: string; objectId: string }[] = [];
    try {
      await expect(
        plannedTargetCollisions(workspace, [EXISTING_PAGE], (target) => {
          asked.push({ ...target });
          return false;
        }),
      ).resolves.toEqual([{ path: EXISTING_PAGE, existing: "file", updateRefused: "write-grant" }]);
      // The grant judged the page's Git blob at the revision, the identity a
      // patch's preimage carries.
      expect(asked).toEqual([{ path: EXISTING_PAGE, objectId: gitBlobObjectId(STUB) }]);
      await expect(
        plannedTargetCollisions(workspace, [EXISTING_PAGE], () => true),
      ).resolves.toEqual([
        { path: EXISTING_PAGE, existing: "file", base: { sha256: STUB_SHA256 } },
      ]);
    } finally {
      await workspace.dispose();
    }
  });

  it("reads a page's revision object ID until an admitted write replaces the page", async () => {
    const { workspace } = await fixtureWorkspace();
    try {
      await expect(trackedRepositoryBlobObjectId(workspace, EXISTING_PAGE)).resolves.toBe(
        gitBlobObjectId(STUB),
      );
      await expect(trackedRepositoryBlobObjectId(workspace, "docs/routing")).resolves.toBe(
        undefined,
      );
      await writeFile(join(workspace.path, EXISTING_PAGE), "# Rewritten\n");
      await expect(admitAuthorizedTrackedWrites(workspace, [EXISTING_PAGE])).resolves.toEqual([
        EXISTING_PAGE,
      ]);
      await expect(trackedRepositoryBlobObjectId(workspace, EXISTING_PAGE)).resolves.toBe(
        undefined,
      );
    } finally {
      await workspace.dispose();
    }
  });

  it("admits a write at repository.trackedWriteAdmissionMaxBytes and leaves one byte over it quarantined", async () => {
    const { workspace } = await fixtureWorkspace();
    const bound = 32;
    const at = "docs/routing/at-bound.md";
    const over = "docs/routing/over-bound.md";
    try {
      vi.stubEnv("DOCSFAB_REPOSITORY_TRACKED_WRITE_ADMISSION_MAX_BYTES", String(bound));
      await writeFile(join(workspace.path, at), Buffer.alloc(bound, "a"));
      await writeFile(join(workspace.path, over), Buffer.alloc(bound + 1, "a"));
      await expect(admitAuthorizedTrackedWrites(workspace, [over, at])).resolves.toEqual([at]);
    } finally {
      vi.unstubAllEnvs();
      await workspace.dispose();
    }
  });

  it.each([
    [
      "a same-size rewrite of other bytes with its modification time restored",
      async (absolute: string) => {
        const before = await stat(absolute);
        await writeFile(absolute, STUB.replace("stub", "STUB"));
        await utimes(absolute, before.atime, before.mtime);
      },
    ],
    [
      "a delete and recreate with other bytes",
      async (absolute: string) => {
        await rm(absolute);
        await writeFile(absolute, "# Another guide\n");
      },
    ],
    ["a delete", (absolute: string) => rm(absolute)],
    [
      "a parent directory swapped for a link to a copy of it",
      async (absolute: string) => {
        const parent = dirname(absolute);
        const copy = `${parent}-copy`;
        await mkdir(copy);
        await writeFile(join(copy, basename(absolute)), STUB);
        await rm(parent, { recursive: true });
        await symlink(copy, parent);
      },
    ],
  ])("refuses the revision object ID of a page changed on disk by %s", async (_name, change) => {
    const { workspace } = await fixtureWorkspace();
    try {
      await change(join(workspace.path, EXISTING_PAGE));
      await expect(trackedRepositoryBlobObjectId(workspace, EXISTING_PAGE)).rejects.toMatchObject({
        name: "RepositoryWorkspaceReadError",
        code: "changed",
      });
    } finally {
      await workspace.dispose();
    }
  });

  it("returns the revision object ID of a page recreated with the same bytes", async () => {
    const { workspace } = await fixtureWorkspace();
    try {
      const absolute = join(workspace.path, EXISTING_PAGE);
      await rm(absolute);
      await writeFile(absolute, STUB);
      // The identity is the content, whatever inode or timestamps the file got.
      await expect(trackedRepositoryBlobObjectId(workspace, EXISTING_PAGE)).resolves.toBe(
        gitBlobObjectId(STUB),
      );
    } finally {
      await workspace.dispose();
    }
  });

  it.skipIf(process.getuid?.() === 0)(
    "reports a page the file system will not let it read as a failed read",
    async () => {
      const { workspace } = await fixtureWorkspace();
      const absolute = join(workspace.path, EXISTING_PAGE);
      try {
        await chmod(absolute, 0o000);
        await expect(trackedRepositoryBlobObjectId(workspace, EXISTING_PAGE)).rejects.toMatchObject(
          { name: "RepositoryWorkspaceReadError", code: "read-failed" },
        );
      } finally {
        await chmod(absolute, 0o644);
        await workspace.dispose();
      }
    },
  );

  it("asks the write grant about a page larger than any buffered single-file read", {
    timeout: testTimeoutMs(EXPORT_CASE_LOCAL_MS),
  }, async () => {
    // Larger than any single-file read the authoring host allows.
    const large = `# Large page\n${"x".repeat(9 * 1024 * 1024)}\n`;
    const { workspace } = await fixtureWorkspace({ "docs/large.md": large });
    try {
      await expect(
        plannedTargetCollisions(workspace, ["docs/large.md"], ({ objectId }) => {
          return objectId === gitBlobObjectId(large);
        }),
      ).resolves.toEqual([
        {
          path: "docs/large.md",
          existing: "file",
          base: { sha256: createHash("sha256").update(large).digest("hex") },
        },
      ]);
    } finally {
      await workspace.dispose();
    }
  });

  it.skipIf(caseInsensitiveHost)(
    "gives no base when two tracked pages fold to the same path",
    async () => {
      const { workspace } = await fixtureWorkspace({ "docs/routing/Guide.md": "# Twin\n" });
      try {
        await expect(plannedTargetCollisions(workspace, [EXISTING_PAGE])).resolves.toEqual([
          { path: EXISTING_PAGE, existing: "file" },
        ]);
      } finally {
        await workspace.dispose();
      }
    },
  );

  it("classifies the refusal as a planning refusal with its catalogued code", () => {
    const error = new CreateTargetExistsError(
      [{ path: EXISTING_PAGE, existing: "file" }],
      "plan-admission",
    );
    expect(error.message).toBe(
      "create-target-exists: the CREATE plan targets 1 path(s) that already exist at the run's " +
        "repository revision (docs/routing/guide.md exists under another letter case or as a " +
        "link, submodule, or excluded entry). Scope: CREATE plan admission, before any page was " +
        "written. Remediation: name a new path for the new page. To change an existing page, " +
        "name its exact tracked path or run update-documentation.",
    );
    expect(
      new CreateTargetExistsError(
        [{ path: EXISTING_PAGE, existing: "file", updateRefused: "write-grant" }],
        "plan-admission",
      ).message,
    ).toContain(
      "(docs/routing/guide.md exists, and the run's write grant does not cover modifying it)",
    );
    expect(classifyThrownFailure(error, "workflow")).toEqual({
      class: "planning-refusal",
      layer: "workflow",
      code: "create-target-exists",
    });
  });

  /**
   * Candidate 0 of a CREATE writer that replaced the existing stub, the
   * recorded live shape, and the inputs every reconstruction of it shares.
   */
  async function stubReplacementCandidate() {
    const { source, revision, workspace } = await fixtureWorkspace();
    const artifacts = await temporary.create("docsfab-create-target-artifacts-");
    const collector = await GitPatchEvidenceCollector.create(workspace.path, artifacts);
    const repository = { sourcePath: source, requestedRevision: revision, revision };
    const sourceLedger = {
      kind: "docsfab-source-obligation-ledger" as const,
      schemaVersion: 1 as const,
      identity: {
        repositoryRevision: revision,
        scopeSha256: "b".repeat(64),
        sourceEvidenceSha256: "e".repeat(64),
        workspaceSnapshotSha256: "f".repeat(64),
        sources: [
          {
            path: SOURCE,
            sha256: createHash("sha256")
              .update(await readFile(join(source, SOURCE)))
              .digest("hex"),
          },
        ],
      },
      completeness: "bounded-not-proven" as const,
      dimensions: [],
      limitations: [],
      digest: "a".repeat(64),
    };
    const dispose = async () => {
      await collector.dispose();
      await workspace.dispose();
    };
    try {
      await writeFile(join(workspace.path, EXISTING_PAGE), "# Routing guide\n\nNew body.\n");
      const candidate0 = await sealAuthoringCandidate({
        runId: "run-create-target",
        repository,
        ordinal: 0,
        originalRevision: revision,
        planDigest: "b".repeat(64),
        writePaths: [EXISTING_PAGE],
        workspace,
        evidenceCollector: collector,
        sourceLedger,
      });
      return {
        dispose,
        reconstruction: {
          runId: "run-create-target",
          candidate0,
          sourceWorkspace: workspace,
          repository,
          sourceLedger,
          artifactDirectory: artifacts,
        },
      };
    } catch (error) {
      await dispose();
      throw error;
    }
  }

  it("refuses candidate reconstruction over an existing path with the same code", {
    timeout: testTimeoutMs(EXPORT_CASE_LOCAL_MS),
  }, async () => {
    const { dispose, reconstruction } = await stubReplacementCandidate();
    try {
      const refusal = await prepareAuthoringRevisionWorkspace(reconstruction).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(refusal).toBeInstanceOf(CreateTargetExistsError);
      expect(refusal).toMatchObject({
        code: "create-target-exists",
        scope: "candidate-reconstruction",
        collisions: [{ path: EXISTING_PAGE, existing: "file" }],
      });
      expect(classifyThrownFailure(refusal, "workflow").code).toBe("create-target-exists");
    } finally {
      await dispose();
    }
  });

  it("reconstructs a converted candidate over exactly the converted base", {
    timeout: testTimeoutMs(EXPORT_CASE_LOCAL_MS),
  }, async () => {
    const { dispose, reconstruction } = await stubReplacementCandidate();
    try {
      const revisionWorkspace = await prepareAuthoringRevisionWorkspace({
        ...reconstruction,
        createConvertedToUpdate: { path: EXISTING_PAGE, baseSha256: STUB_SHA256 },
      });
      try {
        await expect(
          readFile(join(revisionWorkspace.workspace.path, EXISTING_PAGE), "utf8"),
        ).resolves.toBe("# Routing guide\n\nNew body.\n");
      } finally {
        await revisionWorkspace.dispose();
      }
    } finally {
      await dispose();
    }
  });

  it("refuses a conversion that names a path outside candidate 0's plan", {
    timeout: testTimeoutMs(EXPORT_CASE_LOCAL_MS),
  }, async () => {
    const { dispose, reconstruction } = await stubReplacementCandidate();
    try {
      await expect(
        prepareAuthoringRevisionWorkspace({
          ...reconstruction,
          createConvertedToUpdate: { path: "README.md", baseSha256: STUB_SHA256 },
        }),
      ).rejects.toThrow("names a path outside candidate 0's plan");
    } finally {
      await dispose();
    }
  });

  it("refuses a converted reconstruction whose base the revision does not hold", {
    timeout: testTimeoutMs(EXPORT_CASE_LOCAL_MS),
  }, async () => {
    const { dispose, reconstruction } = await stubReplacementCandidate();
    try {
      await expect(
        prepareAuthoringRevisionWorkspace({
          ...reconstruction,
          createConvertedToUpdate: { path: EXISTING_PAGE, baseSha256: "0".repeat(64) },
        }),
      ).rejects.toThrow("is not the base the plan converted");
    } finally {
      await dispose();
    }
  });
});
