// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyGovernedAssetBundle, verifyGovernedAssetCatalog } from "../src/assets/lock.js";
import { temporaryRoots } from "./helpers/temp.js";

const temporary = temporaryRoots();
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const empty = { schemaVersion: 1, bundleHashFormat: "sha256-provenance-lines-v1", bundles: [] };

async function catalog(value: unknown): Promise<string> {
  const root = await temporary.create("docsfab-portable-assets-");
  await mkdir(join(root, "governed-assets"));
  await writeFile(join(root, "governed-assets/lock.json"), JSON.stringify(value));
  return root;
}

// Newly authored contract input; no imported optional payload is needed for this seam.
async function syntheticBundle(): Promise<string> {
  const body = "# Portable asset\n\nThis small document exercises locked-byte integrity.\n";
  const bundle = {
    id: "portable-sample",
    version: "1.0.0",
    license: "Apache-2.0",
    localPath: "governed-assets/portable-sample",
    source: {
      repository: "https://assets.example.test/portable.git",
      revision: "a".repeat(40),
      path: "portable-sample",
    },
    bundleSha256: "",
    files: [{ path: "nested/document.md", sha256: hash(body) }],
  };
  bundle.bundleSha256 = hash(
    `repository ${bundle.source.repository}\nrevision ${bundle.source.revision}\n` +
      `source-path ${bundle.source.path}\nlocal-path ${bundle.localPath}\n` +
      `version ${bundle.version}\nlicense ${bundle.license}\n` +
      `${hash(body)}  nested/document.md\n`,
  );
  const root = await catalog({ ...empty, bundles: [bundle] });
  await mkdir(join(root, bundle.localPath, "nested"), { recursive: true });
  await writeFile(join(root, bundle.localPath, "nested/document.md"), body);
  return root;
}

describe("portable governed asset catalog", () => {
  it("validates a present empty catalog and refuses an unavailable bundle", async () => {
    const root = await catalog(empty);
    await expect(verifyGovernedAssetCatalog(root)).resolves.toEqual([]);
    await expect(verifyGovernedAssetBundle(root, "portable-sample")).rejects.toThrow(
      "is not locked",
    );
  });

  it.each([
    { ...empty, schemaVersion: 2 },
    { ...empty, bundleHashFormat: "unknown" },
    { ...empty, bundles: null },
    { ...empty, unrecognized: true },
    { ...empty, private_token: "CATALOG_TOKEN_SENTINEL" },
  ])("does not let an empty catalog bypass strict validation: %j", async (value) => {
    const root = await catalog(value);
    await expect(verifyGovernedAssetCatalog(root)).rejects.toThrow();
  });

  it("refuses a missing catalog", async () => {
    const root = await catalog(empty);
    await rm(join(root, "governed-assets/lock.json"));
    await expect(verifyGovernedAssetCatalog(root)).rejects.toThrow();
  });

  it("verifies synthetic content, then refuses tampering and extra files", async () => {
    const root = await syntheticBundle();
    await expect(verifyGovernedAssetCatalog(root)).resolves.toEqual(["portable-sample"]);
    await expect(verifyGovernedAssetBundle(root, "portable-sample")).resolves.toMatchObject({
      evidence: { id: "portable-sample", files: [{ path: "nested/document.md" }] },
    });
    const path = join(root, "governed-assets/portable-sample/nested/document.md");
    const original = await readFile(path);
    await writeFile(path, "modified\n");
    await expect(verifyGovernedAssetBundle(root, "portable-sample")).rejects.toThrow(
      "checksum mismatch",
    );
    await writeFile(path, original);
    await writeFile(join(root, "governed-assets/portable-sample/unlocked.md"), "extra\n");
    await expect(verifyGovernedAssetBundle(root, "portable-sample")).rejects.toThrow();
  });

  it("refuses a symlink in a synthetic bundle", async () => {
    const root = await syntheticBundle();
    const path = join(root, "governed-assets/portable-sample/nested/document.md");
    await rm(path);
    await symlink(join(root, "governed-assets/lock.json"), path);
    await expect(verifyGovernedAssetBundle(root, "portable-sample")).rejects.toThrow("unsafe path");
  });
});
