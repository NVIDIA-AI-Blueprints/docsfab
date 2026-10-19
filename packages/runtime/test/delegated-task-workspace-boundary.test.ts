// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DELEGATED_CHILD_WORKSPACE_ORIGIN,
  hashWorkingTreeBlob,
  inspectDelegatedWorkspaceBasis,
  isWorkspaceMutationCommand,
  readCommittedHeadFile,
  relevantDirtyPaths,
  refuseWorkspaceMutation,
  verifySavedPatchPreimage,
} from "../src/delegated-task/workspace-basis.js";
import { temporaryRoots } from "./helpers/temp.js";
import { initFixtureRepo } from "./helpers/git.js";

const directories = temporaryRoots();

async function workspaceFixture(): Promise<{ repositoryPath: string; revision: string }> {
  const root = await directories.create("docsfab-delegated-workspace-");
  const repositoryPath = join(root, "fixture");
  const revision = await initFixtureRepo(
    repositoryPath,
    { "docs/guide.md": "Committed guide.\n", "notes/scratch.md": "Committed scratch.\n" },
    { branch: "main" },
  );
  return { repositoryPath, revision };
}

describe("delegated-task workspace boundary", () => {
  it("treats relevant dirty docs/guide.md as blocking and unrelated notes/scratch.md as non-blocking", async () => {
    const { repositoryPath, revision } = await workspaceFixture();
    await writeFile(join(repositoryPath, "docs", "guide.md"), "Uncommitted guide.\n", "utf8");
    await writeFile(join(repositoryPath, "notes", "scratch.md"), "Uncommitted scratch.\n", "utf8");
    const basis = await inspectDelegatedWorkspaceBasis(repositoryPath);
    expect(basis.committedHeadRevision).toBe(revision);
    expect(basis.workspace.origin).toBe(DELEGATED_CHILD_WORKSPACE_ORIGIN);
    expect(basis.workspace.strategy).toBe("tracked-export");
    expect(basis.workspace.disposable).toBe(true);
    const relevant = relevantDirtyPaths(basis, ["docs/guide.md"]);
    expect(relevant.map((entry) => entry.path)).toEqual(["docs/guide.md"]);
    const unrelated = relevantDirtyPaths(basis, ["docs/guide.md"]).filter((entry) =>
      entry.path.startsWith("notes/"),
    );
    expect(unrelated).toEqual([]);
    expect(await readFile(join(repositoryPath, "docs", "guide.md"), "utf8")).toBe(
      "Uncommitted guide.\n",
    );
  });

  it("feeds child workflows committed HEAD bytes rather than current uncommitted checkout edits", async () => {
    const { repositoryPath, revision } = await workspaceFixture();
    await writeFile(join(repositoryPath, "docs", "guide.md"), "Uncommitted guide.\n", "utf8");
    const head = await readCommittedHeadFile(repositoryPath, "docs/guide.md");
    expect(head.origin).toBe("committed-head");
    expect(head.revision).toBe(revision);
    expect(head.bytes.toString("utf8")).toBe("Committed guide.\n");
    expect(await readFile(join(repositoryPath, "docs", "guide.md"), "utf8")).toBe(
      "Uncommitted guide.\n",
    );
    expect(head.bytes.toString("utf8")).not.toBe("Uncommitted guide.\n");
  });

  it("rejects a saved-patch preimage taken from the dirty checkout and matches HEAD preimages", async () => {
    const { repositoryPath } = await workspaceFixture();
    const head = await readCommittedHeadFile(repositoryPath, "docs/guide.md");
    await writeFile(join(repositoryPath, "docs", "guide.md"), "Uncommitted guide.\n", "utf8");
    const dirtyObjectId = await hashWorkingTreeBlob(repositoryPath, "docs/guide.md");
    expect(dirtyObjectId).not.toBe(head.objectId);
    const dirtyPreimage = await verifySavedPatchPreimage({
      repositoryPath,
      changedFiles: [{ path: "docs/guide.md", preimageObjectId: dirtyObjectId }],
    });
    expect(dirtyPreimage.status).toBe("rejected");
    expect(dirtyPreimage.basis).toBe("committed-head");
    expect(dirtyPreimage.mismatchedPaths).toEqual(["docs/guide.md"]);
    const headPreimage = await verifySavedPatchPreimage({
      repositoryPath,
      changedFiles: [{ path: "docs/guide.md", preimageObjectId: head.objectId }],
    });
    expect(headPreimage.status).toBe("matched");
    expect(await readFile(join(repositoryPath, "docs", "guide.md"), "utf8")).toBe(
      "Uncommitted guide.\n",
    );
  });

  it("treats an untracked declared path as relevant dirt without mutating the checkout", async () => {
    const { repositoryPath, revision } = await workspaceFixture();
    await writeFile(join(repositoryPath, "docs", "extra.md"), "Untracked extra.\n", "utf8");
    const basis = await inspectDelegatedWorkspaceBasis(repositoryPath);
    const relevant = relevantDirtyPaths(basis, ["docs/extra.md"]);
    expect(relevant).toEqual([
      expect.objectContaining({ path: "docs/extra.md", kind: "untracked" }),
    ]);
    expect(basis.committedHeadRevision).toBe(revision);
    expect(await readFile(join(repositoryPath, "docs", "extra.md"), "utf8")).toBe(
      "Untracked extra.\n",
    );
  });

  it("does not expose commit, stash, reset, checkout, or snapshot as workspace-bridge commands", () => {
    expect(isWorkspaceMutationCommand("stash")).toBe(true);
    expect(isWorkspaceMutationCommand("status")).toBe(false);
    expect(() => refuseWorkspaceMutation("stash")).toThrow(/stash/u);
  });
});
