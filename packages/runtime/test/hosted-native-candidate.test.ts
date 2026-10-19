// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { createHostedNativeCandidate } from "../src/host-invoker/native-candidate.js";

const exec = promisify(execFile),
  roots: string[] = [];
const git = (args: string[]) =>
  exec("/usr/bin/git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
    env: {
      PATH: "/usr/bin:/bin",
      HOME: "/dev/null",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "docsfab-native-candidate-")));
  roots.push(root);
  const source = join(root, "source"),
    stateDirectory = join(root, "state");
  await git(["init", "--quiet", source]);
  await mkdir(stateDirectory);
  await chmod(stateDirectory, 0o700);
  await writeFile(join(source, "README.md"), "# First revision\n");
  await git(["-C", source, "add", "."]);
  await git([
    "-C",
    source,
    "-c",
    "user.name=DocsFab Test",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "first",
  ]);
  const revision = (await git(["-C", source, "rev-parse", "HEAD"])).stdout.trim();
  const treeObjectId = (await git(["-C", source, "rev-parse", "HEAD^{tree}"])).stdout.trim();
  await writeFile(join(source, "README.md"), "# Second revision\n");
  await git(["-C", source, "add", "."]);
  await git([
    "-C",
    source,
    "-c",
    "user.name=DocsFab Test",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "second",
  ]);
  return { root, source, stateDirectory, revision, treeObjectId };
}

it("copies the exact selected commit into an independent candidate and preserves the source", async () => {
  const f = await fixture(),
    before = (await git(["-C", f.source, "rev-parse", "HEAD"])).stdout;
  const marker = join(f.root, "unexpected-hook");
  const hook = join(f.root, "pack-hook.sh");
  await writeFile(hook, `#!/bin/sh\ntouch '${marker}'\nexec /usr/bin/git pack-objects "$@"\n`, {
    mode: 0o700,
  });
  await git(["-C", f.source, "config", "uploadpack.packObjectsHook", hook]);
  const candidate = await createHostedNativeCandidate({ ...f, sourcePath: f.source });
  await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(candidate.workspacePath, "README.md"), "utf8")).toBe(
    "# First revision\n",
  );
  expect(candidate.revision).toBe(f.revision);
  expect(candidate.treeObjectId).toBe(f.treeObjectId);
  await expect(
    stat(join(candidate.workspacePath, ".git", "objects", "info", "alternates")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await writeFile(join(candidate.workspacePath, "README.md"), "# Candidate edit\n");
  expect(await readFile(join(f.source, "README.md"), "utf8")).toBe("# Second revision\n");
  expect((await git(["-C", f.source, "rev-parse", "HEAD"])).stdout).toBe(before);
  expect((await git(["-C", f.source, "status", "--porcelain"])).stdout).toBe("");
  await candidate.dispose();
  await candidate.dispose();
  expect(await readdir(f.stateDirectory)).toEqual([]);
});

it("refuses another tree or aliased attempt directory before creating a candidate", async () => {
  const f = await fixture();
  await expect(
    createHostedNativeCandidate({ ...f, sourcePath: f.source, treeObjectId: "a".repeat(40) }),
  ).rejects.toThrow("exact outer request");
  const alias = join(f.root, "alias");
  await symlink(f.stateDirectory, alias);
  await expect(
    createHostedNativeCandidate({ ...f, sourcePath: f.source, stateDirectory: alias }),
  ).rejects.toThrow("private attempt");
  expect(await readdir(f.stateDirectory)).toEqual([]);
});
