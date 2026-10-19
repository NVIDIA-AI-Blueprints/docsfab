// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  cp,
  link,
  lstat,
  mkdir,
  readFile,
  rename,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { GitPatchEvidenceCollector } from "../src/repository/evidence.js";
import { temporaryRoots } from "./helpers/temp.js";

const temporaryDirectories = temporaryRoots();
const execFileAsync = promisify(execFile);

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function context(workspacePath: string, persistPatch = true) {
  return {
    runId: "run-1",
    workspacePath,
    persistPatch,
    repository: {
      sourcePath: "/source",
      requestedRevision: "HEAD",
      revision: "abc123",
    },
  };
}

describe("GitPatchEvidenceCollector", () => {
  it("persists a standard patch for text, rename, copy, and binary changes", async () => {
    const root = await temporaryDirectories.create("docsfab-evidence-test-");
    const workspacePath = join(root, "workspace");
    const reviewPath = join(root, "review");
    const artifactDirectory = join(root, "artifacts");
    await mkdir(join(workspacePath, "docs"), { recursive: true });
    await writeFile(join(workspacePath, "README.md"), "before\n");
    await writeFile(join(workspacePath, "obsolete.md"), "remove me\n");
    await writeFile(join(workspacePath, "rename-me.md"), "rename content\n");
    await writeFile(join(workspacePath, "copy-me.md"), "copy content\n");
    await writeFile(join(workspacePath, "image.bin"), Buffer.from([0, 1, 2, 3, 0, 4, 5]));
    await cp(workspacePath, reviewPath, { recursive: true });
    const collector = await GitPatchEvidenceCollector.create(workspacePath, artifactDirectory);

    try {
      await writeFile(join(workspacePath, "README.md"), "after secret-like text\n");
      await writeFile(join(workspacePath, "docs", "new.md"), "new content\n");
      await unlink(join(workspacePath, "obsolete.md"));
      await rename(join(workspacePath, "rename-me.md"), join(workspacePath, "renamed.md"));
      await writeFile(join(workspacePath, "copied.md"), "copy content\n");
      await writeFile(join(workspacePath, "image.bin"), Buffer.from([0, 1, 2, 3, 0, 255, 128]));

      const evidence = await collector.capture(context(workspacePath));
      expect(evidence.files).toEqual([
        { path: "README.md", status: "modified" },
        {
          path: "copied.md",
          previousPath: "copy-me.md",
          status: "copied",
        },
        { path: "docs/new.md", status: "added" },
        { path: "image.bin", status: "modified" },
        { path: "obsolete.md", status: "deleted" },
        {
          path: "renamed.md",
          previousPath: "rename-me.md",
          status: "renamed",
        },
      ]);

      const artifactPath = evidence.patch?.artifactPath;
      expect(artifactPath).toBe(join(artifactDirectory, "run-1.patch"));
      const patch = await readFile(artifactPath ?? "");
      expect((await stat(artifactPath ?? "")).mode & 0o777).toBe(0o600);
      expect(evidence.patch).toEqual({
        sha256: createHash("sha256").update(patch).digest("hex"),
        byteLength: patch.byteLength,
        lineCount: patch.toString("utf8").split("\n").length - 1,
        artifactPath,
        format: "git-diff",
      });
      expect(patch.toString("utf8")).toContain("rename from rename-me.md");
      expect(patch.toString("utf8")).toContain("copy from copy-me.md");
      expect(patch.toString("utf8")).toContain("GIT binary patch");
      expect(JSON.stringify(evidence)).not.toContain("secret-like text");
      await execFileAsync("git", ["apply", "--check", artifactPath ?? ""], {
        cwd: reviewPath,
      });
      await execFileAsync("git", ["apply", artifactPath ?? ""], {
        cwd: reviewPath,
      });
      expect(await readFile(join(reviewPath, "image.bin"))).toEqual(
        Buffer.from([0, 1, 2, 3, 0, 255, 128]),
      );
      expect(await exists(join(reviewPath, "rename-me.md"))).toBe(false);
      expect(await readFile(join(reviewPath, "renamed.md"), "utf8")).toBe("rename content\n");
    } finally {
      await collector.dispose();
    }
    expect(await exists(join(workspacePath, ".git"))).toBe(false);
    expect(await exists(join(artifactDirectory, "run-1.patch"))).toBe(true);
  });

  it("records paths without creating an artifact for read-only runs", async () => {
    const root = await temporaryDirectories.create("docsfab-evidence-test-");
    const workspacePath = join(root, "workspace");
    const artifactDirectory = join(root, "artifacts");
    await mkdir(workspacePath);
    const collector = await GitPatchEvidenceCollector.create(workspacePath, artifactDirectory);
    try {
      await writeFile(join(workspacePath, "unexpected.md"), "content\n");
      await expect(collector.capture(context(workspacePath, false))).resolves.toEqual({
        files: [{ path: "unexpected.md", status: "added" }],
      });
      expect(await exists(artifactDirectory)).toBe(false);
    } finally {
      await collector.dispose();
    }
  });

  it("persists an empty patch for an unchanged write-capable run", async () => {
    const root = await temporaryDirectories.create("docsfab-evidence-test-");
    const workspacePath = join(root, "workspace");
    await mkdir(workspacePath);
    const collector = await GitPatchEvidenceCollector.create(
      workspacePath,
      join(root, "artifacts"),
    );
    try {
      const evidence = await collector.capture(context(workspacePath));
      expect(evidence.files).toEqual([]);
      expect(evidence.patch).toMatchObject({
        sha256: createHash("sha256").update("").digest("hex"),
        byteLength: 0,
        lineCount: 0,
      });
      expect(await readFile(evidence.patch?.artifactPath ?? "", "utf8")).toBe("");
    } finally {
      await collector.dispose();
    }
  });

  it("fails explicitly when the patch directory cannot be created", async () => {
    const root = await temporaryDirectories.create("docsfab-evidence-test-");
    const workspacePath = join(root, "workspace");
    const blockedPath = join(root, "blocked");
    await mkdir(workspacePath);
    await writeFile(blockedPath, "not a directory");
    const collector = await GitPatchEvidenceCollector.create(workspacePath, blockedPath);
    try {
      await writeFile(join(workspacePath, "new.md"), "content\n");
      await expect(collector.capture(context(workspacePath))).rejects.toThrow();
    } finally {
      await collector.dispose();
    }
  });
  it.each([0o0000, 0o0002])("makes the patch namespace private under umask %s", async (umask) => {
    const root = await temporaryDirectories.create("docsfab-evidence-private-");
    const workspacePath = join(root, "workspace");
    await mkdir(workspacePath);
    const parent = join(root, "shared");
    await mkdir(parent);
    await chmod(parent, 0o777);
    const parentBefore = await lstat(parent);
    const previous = process.umask(umask);
    const collector = await GitPatchEvidenceCollector.create(
      workspacePath,
      join(parent, "patches"),
    );
    try {
      await writeFile(join(workspacePath, "new.md"), "new content\n");
      const evidence = await collector.capture(context(workspacePath));
      expect((await lstat(join(parent, "patches"))).mode & 0o777).toBe(0o700);
      expect((await lstat(evidence.patch!.artifactPath)).mode & 0o777).toBe(0o600);
      expect(await readFile(evidence.patch!.artifactPath, "utf8")).toContain("new content");
      const parentAfter = await lstat(parent);
      expect([parentAfter.dev, parentAfter.ino, parentAfter.mode & 0o777]).toEqual([
        parentBefore.dev,
        parentBefore.ino,
        0o777,
      ]);
    } finally {
      process.umask(previous);
      await collector.dispose();
    }
  });

  it("refuses an existing broad patch root and keeps retained patch bytes", async () => {
    const root = await temporaryDirectories.create("docsfab-evidence-broad-");
    const workspacePath = join(root, "workspace");
    const patchRoot = join(root, "patches");
    await mkdir(workspacePath);
    await mkdir(patchRoot);
    const retained = join(patchRoot, "old.patch");
    await writeFile(retained, "retained\n", { mode: 0o600 });
    await chmod(patchRoot, 0o777);
    const collector = await GitPatchEvidenceCollector.create(workspacePath, patchRoot);
    try {
      await writeFile(join(workspacePath, "new.md"), "new content\n");
      await expect(collector.capture(context(workspacePath))).rejects.toThrow(
        /patches|private|unsafe/i,
      );
      expect(await readFile(retained, "utf8")).toBe("retained\n");
      expect((await lstat(patchRoot)).mode & 0o777).toBe(0o777);
    } finally {
      await collector.dispose();
    }
  });

  it("refuses a symlink patch namespace without altering the foreign target", async () => {
    const root = await temporaryDirectories.create("docsfab-evidence-link-");
    const workspacePath = join(root, "workspace");
    const foreign = join(root, "foreign");
    await mkdir(workspacePath);
    await mkdir(foreign, { mode: 0o700 });
    await writeFile(join(foreign, "sentinel"), "retained\n", { mode: 0o600 });
    await symlink(foreign, join(root, "patches"));
    const collector = await GitPatchEvidenceCollector.create(workspacePath, join(root, "patches"));
    try {
      await writeFile(join(workspacePath, "new.md"), "new content\n");
      await expect(collector.capture(context(workspacePath))).rejects.toThrow();
      expect(await readFile(join(foreign, "sentinel"), "utf8")).toBe("retained\n");
      expect(await exists(join(foreign, "run-1.patch"))).toBe(false);
    } finally {
      await collector.dispose();
    }
  });

  it("refuses a multiply-linked existing patch destination without replacing it", async () => {
    const root = await temporaryDirectories.create("docsfab-evidence-hardlink-");
    const workspacePath = join(root, "workspace");
    const patchRoot = join(root, "patches");
    await mkdir(workspacePath);
    await mkdir(patchRoot, { mode: 0o700 });
    const destination = join(patchRoot, "run-1.patch");
    await writeFile(destination, "retained\n", { mode: 0o600 });
    const other = join(root, "second-link");
    await link(destination, other);
    const collector = await GitPatchEvidenceCollector.create(workspacePath, patchRoot);
    try {
      await writeFile(join(workspacePath, "new.md"), "new content\n");
      await expect(collector.capture(context(workspacePath))).rejects.toThrow();
      expect(await readFile(destination, "utf8")).toBe("retained\n");
      expect(await readFile(other, "utf8")).toBe("retained\n");
    } finally {
      await collector.dispose();
    }
  });
});
