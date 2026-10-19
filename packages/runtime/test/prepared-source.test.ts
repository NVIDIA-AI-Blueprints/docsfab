// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { prepareLocalSourceSnapshot } from "../src/inputs/prepared-source-reader.js";
import { initFixtureRepo } from "./helpers/git.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(files: Readonly<Record<string, Uint8Array | string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "docsfab-prepared-source-"));
  temporary.push(root);
  await initFixtureRepo(root, files);
  return root;
}

describe("prepared local source snapshots (#2519)", () => {
  it("pins multiple documentation roots and root-level files to exact Git bytes", async () => {
    const readme = Buffer.from([0x52, 0x00, 0xff, 0x0a]);
    const guide = Buffer.from("<html>source bytes stay exact</html>\n", "utf8");
    const outside = Buffer.from("not in declared roots", "utf8");
    const repositoryPath = await fixture({
      "README.txt": readme,
      "docs/guide.html": guide,
      "api/openapi.json": '{"openapi":"3.1.0"}\n',
      "private/outside.txt": outside,
    });

    const snapshot = await prepareLocalSourceSnapshot({
      sourceId: "handbook",
      repositoryPath,
      documentationRoots: ["README.txt", "docs", "api"],
    });

    expect(snapshot.ref.repositoryRevision).toMatch(/^[a-f0-9]{40,64}$/u);
    expect(snapshot.ref.paths).toEqual(["README.txt", "api/openapi.json", "docs/guide.html"]);
    expect(snapshot.files.map((file) => [file.path, Buffer.from(file.bytes)])).toEqual([
      ["README.txt", readme],
      ["api/openapi.json", Buffer.from('{"openapi":"3.1.0"}\n', "utf8")],
      ["docs/guide.html", guide],
    ]);
    expect(snapshot.ref.paths).not.toContain("private/outside.txt");
  });

  it("refuses traversal, a symlink in a declared root, and overlapping root scopes", async () => {
    const repositoryPath = await fixture({ "docs/guide.html": "<p>Guide</p>" });

    await expect(
      prepareLocalSourceSnapshot({
        sourceId: "traversal",
        repositoryPath,
        documentationRoots: ["../outside"],
      }),
    ).rejects.toMatchObject({ code: "invalid-source-path" });

    await expect(
      prepareLocalSourceSnapshot({
        sourceId: "overlap",
        repositoryPath,
        documentationRoots: ["docs", "docs/guide.html"],
      }),
    ).rejects.toMatchObject({ code: "invalid-scope" });

    const symlinkRepo = await mkdtemp(join(tmpdir(), "docsfab-prepared-symlink-"));
    temporary.push(symlinkRepo);
    await initFixtureRepo(symlinkRepo, { "docs/guide.html": "<p>Guide</p>" });
    const { symlink } = await import("node:fs/promises");
    const { git } = await import("./helpers/git.js");
    await symlink("../outside.txt", join(symlinkRepo, "docs", "linked.txt"));
    await git(symlinkRepo, ["add", "docs/linked.txt"]);
    await git(symlinkRepo, ["commit", "-q", "-m", "symlink fixture"]);
    await expect(
      prepareLocalSourceSnapshot({
        sourceId: "symlink",
        repositoryPath: symlinkRepo,
        documentationRoots: ["docs"],
      }),
    ).rejects.toMatchObject({ code: "unsafe-entry" });
  });
});
