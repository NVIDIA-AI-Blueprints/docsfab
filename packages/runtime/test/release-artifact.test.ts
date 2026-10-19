// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { verifyReleaseArtifact } from "../scripts/verify-release-artifact.mjs";

const roots: string[] = [];
const REVISION = "a".repeat(40);
afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots.length = 0;
});

async function fixture(): Promise<{
  projectRoot: string;
  artifactRoot: string;
  metadataPath: string;
  tarballPath: string;
  version: string;
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "docsfab-release-artifact-")));
  roots.push(root);
  const projectRoot = join(root, "project");
  const artifactRoot = join(projectRoot, "package-artifacts");
  await mkdir(artifactRoot, { recursive: true });
  const sourcePackage = JSON.parse(await readFile(resolve("package.json"), "utf8")) as {
    name: string;
    version: string;
  };
  await writeFile(join(projectRoot, "package.json"), JSON.stringify(sourcePackage));
  const tarball = Buffer.from("exact verified tarball bytes\n");
  const tarballPath = join(artifactRoot, "docsfab.tgz");
  const metadataPath = join(artifactRoot, "metadata.json");
  await writeFile(tarballPath, tarball);
  await writeFile(
    metadataPath,
    JSON.stringify({
      schemaVersion: 1,
      artifact: "docsfab.tgz",
      name: sourcePackage.name,
      version: sourcePackage.version,
      filename: `docsfab-${sourcePackage.version}.tgz`,
      integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
      sha1: createHash("sha1").update(tarball).digest("hex"),
      size: tarball.byteLength,
      entryCount: 293,
      unpackedSize: 3_555_602,
      sourceRevision: REVISION,
    }),
  );
  return { projectRoot, artifactRoot, metadataPath, tarballPath, version: sourcePackage.version };
}

describe("retained release artifact", { timeout: 30_000 }, () => {
  it("binds exact tarball bytes to package identity, tag, and pipeline revision", async () => {
    const item = await fixture();
    await expect(
      verifyReleaseArtifact({
        projectRoot: item.projectRoot,
        artifactRoot: item.artifactRoot,
        commitTag: `v${item.version}`,
        commitSha: REVISION,
      }),
    ).resolves.toMatchObject({
      name: "docsfab",
      version: item.version,
      sourceRevision: REVISION,
      tarballPath: item.tarballPath,
    });
  });

  it("rejects changed bytes, a different tag, and a different pipeline revision", async () => {
    const item = await fixture();
    const changed = Buffer.from(await readFile(item.tarballPath));
    changed[0] = (changed[0] ?? 0) ^ 1;
    await writeFile(item.tarballPath, changed);
    await expect(
      verifyReleaseArtifact({
        projectRoot: item.projectRoot,
        artifactRoot: item.artifactRoot,
        commitTag: `v${item.version}`,
        commitSha: REVISION,
      }),
    ).rejects.toThrow("do not match verified integrity metadata");

    const next = await fixture();
    await expect(
      verifyReleaseArtifact({
        projectRoot: next.projectRoot,
        artifactRoot: next.artifactRoot,
        commitTag: `v${next.version}-mismatch`,
        commitSha: REVISION,
      }),
    ).rejects.toThrow("release tag does not exactly match");
    await expect(
      verifyReleaseArtifact({
        projectRoot: next.projectRoot,
        artifactRoot: next.artifactRoot,
        commitTag: `v${next.version}`,
        commitSha: "b".repeat(40),
      }),
    ).rejects.toThrow("source revision does not match");
  });
});
