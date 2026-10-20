// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, mkdir, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { FileIssueLifecycleApplyLock, IssueLifecycleAdapterError } from "../src/roadmap/index.js";

describe("issue lifecycle process lock", () => {
  it("propagates lifecycle errors unchanged and releases for the next caller", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-issue-lock-test-"));
    const lock = new FileIssueLifecycleApplyLock({ root });
    const failure = new IssueLifecycleAdapterError("tracker-drift");
    await expect(
      lock.runExclusive("a".repeat(64), async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    await expect(lock.runExclusive("a".repeat(64), async () => "recovered")).resolves.toBe(
      "recovered",
    );
  });

  it("admits one process-safe owner and rejects a concurrent contender", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-issue-lock-test-"));
    const first = new FileIssueLifecycleApplyLock({ root });
    const second = new FileIssueLifecycleApplyLock({ root });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const entry = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const owner = first.runExclusive("b".repeat(64), async () => {
      entered();
      await held;
    });
    await entry;
    await expect(second.runExclusive("b".repeat(64), async () => undefined)).rejects.toMatchObject({
      code: "lock-active",
    });
    release();
    await owner;
  });

  it("quarantines a verified dead owner and an abandoned incomplete claim", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-issue-lock-test-"));
    const key = "c".repeat(64);
    const directory = join(root, `${key}.lock`);
    await mkdir(directory, { mode: 0o700 });
    await writeFile(
      join(directory, "owner.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        pid: 2_000_000_000,
        uid: typeof process.getuid === "function" ? process.getuid() : 0,
        nonce: "00000000-0000-4000-8000-000000000000",
        createdAt: new Date(0).toISOString(),
      })}\n`,
      { mode: 0o600 },
    );
    const lock = new FileIssueLifecycleApplyLock({ root, incompleteStaleAfterMs: 0 });
    await expect(lock.runExclusive(key, async () => "reclaimed")).resolves.toBe("reclaimed");

    await mkdir(directory, { mode: 0o700 });
    await utimes(directory, new Date(0), new Date(0));
    await expect(lock.runExclusive(key, async () => "reclaimed-incomplete")).resolves.toBe(
      "reclaimed-incomplete",
    );

    await mkdir(directory, { mode: 0o700 });
    await writeFile(join(directory, "owner.json"), "partial", { mode: 0o600 });
    await utimes(directory, new Date(0), new Date(0));
    await expect(lock.runExclusive(key, async () => "reclaimed-partial-owner")).resolves.toBe(
      "reclaimed-partial-owner",
    );
  });

  it("rejects a symlinked lock root", async () => {
    const parent = await mkdtemp(join(tmpdir(), "docsfab-issue-lock-test-"));
    const target = await mkdtemp(join(tmpdir(), "docsfab-issue-lock-target-"));
    const root = join(parent, "linked");
    await symlink(target, root);
    await expect(
      new FileIssueLifecycleApplyLock({ root }).runExclusive("d".repeat(64), async () => undefined),
    ).rejects.toMatchObject({ code: "lock-invalid" });
  });
});
