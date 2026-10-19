// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  iaPlanReviewerPolicyDigest,
  loadIaPlanReviewerPolicyFile,
  type IaPlanReviewerPolicyValue,
} from "../src/ia/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("IA reviewer policy file", () => {
  it("loads one stable owner-only Ed25519 reviewer policy", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-review-policy-"));
    roots.push(root);
    const path = join(root, "reviewers.json");
    const value = policy();
    await writeFile(path, JSON.stringify({ ...value, digest: iaPlanReviewerPolicyDigest(value) }), {
      mode: 0o600,
    });
    await expect(loadIaPlanReviewerPolicyFile(path)).resolves.toMatchObject({
      id: value.id,
      reviewers: [{ id: "maintainer:docs", role: "maintainer" }],
    });
  });

  it("rejects insecure and symlinked policy files", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "docsfab-review-policy-bad-"));
    roots.push(root);
    const target = join(root, "target.json");
    const linked = join(root, "linked.json");
    const value = policy();
    await writeFile(
      target,
      JSON.stringify({ ...value, digest: iaPlanReviewerPolicyDigest(value) }),
      {
        mode: 0o600,
      },
    );
    await symlink(target, linked);
    await expect(loadIaPlanReviewerPolicyFile(linked)).rejects.toMatchObject({ code: "symlink" });
    await chmod(target, 0o644);
    await expect(loadIaPlanReviewerPolicyFile(target)).rejects.toMatchObject({
      code: "insecure-permissions",
    });
  });
});

function policy(): IaPlanReviewerPolicyValue {
  const keys = generateKeyPairSync("ed25519");
  return {
    id: "docsfab:ia-reviewers",
    version: "1",
    reviewers: [
      {
        id: "maintainer:docs",
        role: "maintainer",
        publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      },
    ],
  };
}
