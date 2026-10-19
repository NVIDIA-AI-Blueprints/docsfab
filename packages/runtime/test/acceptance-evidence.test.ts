// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { chmod, link, lstat, mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  acceptanceJsonLeafForPath,
  assertAcceptanceEvidenceDirectory,
  AcceptanceEvidenceError,
  pinAcceptanceEvidenceDirectory,
  readAcceptanceJsonLeaf,
  readAcceptanceJsonLeaves,
  writeAcceptanceJsonExclusive,
} from "../src/acceptance-evidence.js";
import { temporaryRoots } from "./helpers/temp.js";

const roots = temporaryRoots();
const execFileAsync = promisify(execFile);

describe("acceptance evidence filesystem", () => {
  it("pins exact private directory identity and rejects unsafe roots", async () => {
    const parent = await roots.create("docsfab-acceptance-evidence-root-");
    const root = join(parent, "evidence");
    await mkdir(root, { mode: 0o700 });
    const pinned = await pinAcceptanceEvidenceDirectory(root);

    expect(pinned.path).toBe(root);
    expect(pinned.mode & 0o7777).toBe(0o700);
    await assertAcceptanceEvidenceDirectory(pinned);

    await chmod(root, 0o755);
    await expect(assertAcceptanceEvidenceDirectory(pinned)).rejects.toMatchObject({
      code: "insecure-permissions",
    });
    await expect(pinAcceptanceEvidenceDirectory(root)).rejects.toMatchObject({
      code: "insecure-permissions",
    });

    await chmod(root, 0o700);
    const linked = join(parent, "linked");
    await symlink(root, linked);
    await expect(pinAcceptanceEvidenceDirectory(linked)).rejects.toMatchObject({
      code: "unsafe-directory",
    });
  });

  it("exclusively writes and safely reads exact 0600 JSON leaves", async () => {
    const root = await privateDirectory("docsfab-acceptance-evidence-roundtrip-");
    const pinned = await pinAcceptanceEvidenceDirectory(root);

    await writeAcceptanceJsonExclusive(pinned, "manifest.json", {
      schemaVersion: 1,
      passed: true,
    });

    expect((await lstat(join(root, "manifest.json"))).mode & 0o7777).toBe(0o600);
    const leaves = await readAcceptanceJsonLeaves(pinned);
    expect(leaves).toHaveLength(1);
    expect(leaves[0]?.file).toBe("manifest.json");
    expect(leaves[0]?.value).toEqual({ schemaVersion: 1, passed: true });
    expect(leaves[0]?.bytes.toString("utf8")).toMatch(/\n$/u);

    await expect(
      writeAcceptanceJsonExclusive(pinned, "manifest.json", { passed: false }),
    ).rejects.toMatchObject({ code: "already-exists" });
    expect(JSON.parse(await readFile(join(root, "manifest.json"), "utf8"))).toEqual({
      schemaVersion: 1,
      passed: true,
    });
  });

  it("rejects symlink, nonregular, permissive, malformed, and non-JSON entries", async () => {
    const parent = await roots.create("docsfab-acceptance-evidence-entries-");
    const external = join(parent, "external.json");
    await writeFile(external, JSON.stringify({ secret: "MODEL_OUTPUT_SENTINEL" }), {
      mode: 0o600,
    });

    for (const [name, setup, expected] of [
      [
        "symlink",
        async (root: string) => symlink(external, join(root, "run.json")),
        "unsafe-entry",
      ],
      [
        "directory",
        async (root: string) => mkdir(join(root, "run.json"), { mode: 0o700 }),
        "unsafe-entry",
      ],
      [
        "permissive",
        async (root: string) => writeFile(join(root, "run.json"), "{}", { mode: 0o644 }),
        "insecure-permissions",
      ],
      [
        "malformed",
        async (root: string) => writeFile(join(root, "run.json"), "{", { mode: 0o600 }),
        "invalid-json",
      ],
      [
        "non-json",
        async (root: string) => writeFile(join(root, "notes.txt"), "safe", { mode: 0o600 }),
        "unsafe-entry",
      ],
      ["hardlink", async (root: string) => link(external, join(root, "run.json")), "unsafe-entry"],
    ] as const) {
      const root = join(parent, name);
      await mkdir(root, { mode: 0o700 });
      await setup(root);
      const pinned = await pinAcceptanceEvidenceDirectory(root);
      await expect(readAcceptanceJsonLeaves(pinned)).rejects.toMatchObject({ code: expected });
    }
  });

  it("rejects a substituted leaf before consuming it", async () => {
    const root = await privateDirectory("docsfab-acceptance-evidence-leaf-swap-");
    const path = join(root, "record.json");
    const displaced = join(root, "record.original.json");
    await writeFile(path, JSON.stringify({ id: "trusted" }), { mode: 0o600 });
    const pinned = await pinAcceptanceEvidenceDirectory(root);

    await expect(
      readAcceptanceJsonLeaf(pinned, "record.json", {
        beforeOpen: async () => {
          await rename(path, displaced);
          await writeFile(path, JSON.stringify({ id: "substituted" }), { mode: 0o600 });
        },
      }),
    ).rejects.toMatchObject({ code: "unsafe-entry" });
  });

  it("rejects directory entry changes during enumeration", async () => {
    const root = await privateDirectory("docsfab-acceptance-evidence-list-race-");
    await writeFile(join(root, "record.json"), JSON.stringify({ id: "trusted" }), {
      mode: 0o600,
    });
    const pinned = await pinAcceptanceEvidenceDirectory(root);

    await expect(
      readAcceptanceJsonLeaves(pinned, {
        afterRead: async () => {
          await writeFile(join(root, "extra.json"), "{}", { mode: 0o600 });
        },
      }),
    ).rejects.toMatchObject({ code: "unsafe-entry" });
  });

  it("rejects a substituted root before consuming a leaf", async () => {
    const parent = await roots.create("docsfab-acceptance-evidence-root-swap-");
    const root = join(parent, "records");
    const displaced = join(parent, "records-original");
    const attacker = join(parent, "records-attacker");
    await mkdir(root, { mode: 0o700 });
    await mkdir(attacker, { mode: 0o700 });
    await writeFile(join(root, "record.json"), JSON.stringify({ id: "trusted" }), {
      mode: 0o600,
    });
    await writeFile(join(attacker, "record.json"), JSON.stringify({ id: "attacker" }), {
      mode: 0o600,
    });
    const pinned = await pinAcceptanceEvidenceDirectory(root);

    await expect(
      readAcceptanceJsonLeaf(pinned, "record.json", {
        beforeOpen: async () => {
          await rename(root, displaced);
          await rename(attacker, root);
        },
      }),
    ).rejects.toMatchObject({ code: "unsafe-directory" });
  });

  it("does not release JSON bytes through substituted write roots or leaves", async () => {
    const parent = await roots.create("docsfab-acceptance-evidence-write-swap-");
    const root = join(parent, "evidence");
    const displacedRoot = join(parent, "evidence-original");
    const attackerRoot = join(parent, "evidence-attacker");
    await mkdir(root, { mode: 0o700 });
    await mkdir(attackerRoot, { mode: 0o700 });
    const pinned = await pinAcceptanceEvidenceDirectory(root);

    await expect(
      writeAcceptanceJsonExclusive(
        pinned,
        "manifest.json",
        { private: "PRIVATE_EVIDENCE_SENTINEL" },
        {
          beforeOpen: async () => {
            await rename(root, displacedRoot);
            await rename(attackerRoot, root);
          },
        },
      ),
    ).rejects.toMatchObject({ code: "unsafe-directory" });
    await expect(lstat(join(root, "manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });

    const leafRoot = join(parent, "leaf-root");
    await mkdir(leafRoot, { mode: 0o700 });
    const leafPinned = await pinAcceptanceEvidenceDirectory(leafRoot);
    const destination = join(leafRoot, "judge-result.json");
    const original = join(leafRoot, "judge-result.original.json");
    await expect(
      writeAcceptanceJsonExclusive(
        leafPinned,
        "judge-result.json",
        { private: "PRIVATE_EVIDENCE_SENTINEL" },
        {
          beforeWrite: async () => {
            await rename(destination, original);
            await writeFile(destination, "attacker sentinel\n", { mode: 0o600 });
          },
        },
      ),
    ).rejects.toMatchObject({ code: "unsafe-entry" });
    expect(await readFile(destination, "utf8")).toBe("attacker sentinel\n");
    expect(await readFile(original, "utf8")).toBe("");
  });

  it("truncates the exclusive-created descriptor after a post-write ancestor swap", async () => {
    const parent = await roots.create("docsfab-acceptance-evidence-after-write-swap-");
    const root = join(parent, "evidence");
    const displaced = join(parent, "evidence-original");
    const attacker = join(parent, "evidence-attacker");
    await mkdir(root, { mode: 0o700 });
    await mkdir(attacker, { mode: 0o700 });
    const pinned = await pinAcceptanceEvidenceDirectory(root);

    await expect(
      writeAcceptanceJsonExclusive(
        pinned,
        "manifest.json",
        { decision: "passed", private: "PRIVATE_EVIDENCE_SENTINEL" },
        {
          afterWrite: async () => {
            await rename(root, displaced);
            await rename(attacker, root);
          },
        },
      ),
    ).rejects.toBeInstanceOf(AcceptanceEvidenceError);

    expect((await readFile(join(displaced, "manifest.json"))).byteLength).toBe(0);
    await expect(lstat(join(root, "manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a same-inode directory reached through a swapped ancestor alias", async () => {
    const parent = await roots.create("docsfab-acceptance-evidence-same-inode-swap-");
    const outputParent = join(parent, "output");
    const root = join(outputParent, "evidence");
    const movedParent = join(parent, "moved");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const pinned = await pinAcceptanceEvidenceDirectory(root);

    await expect(
      writeAcceptanceJsonExclusive(
        pinned,
        "manifest.json",
        { decision: "passed", private: "PRIVATE_EVIDENCE_SENTINEL" },
        {
          afterWrite: async () => {
            await rename(outputParent, movedParent);
            await symlink(movedParent, outputParent);
          },
        },
      ),
    ).rejects.toBeInstanceOf(AcceptanceEvidenceError);

    expect((await readFile(join(movedParent, "evidence", "manifest.json"))).byteLength).toBe(0);
  });

  it("rejects a replaced ancestor even when the pinned leaf returns to its canonical path", async () => {
    const parent = await roots.create("docsfab-acceptance-evidence-ancestor-identity-");
    const outputParent = join(parent, "output");
    const root = join(outputParent, "evidence");
    const movedParent = join(parent, "moved");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const pinned = await pinAcceptanceEvidenceDirectory(root);

    await expect(
      writeAcceptanceJsonExclusive(
        pinned,
        "manifest.json",
        { decision: "passed", private: "PRIVATE_EVIDENCE_SENTINEL" },
        {
          afterWrite: async () => {
            await rename(outputParent, movedParent);
            await mkdir(outputParent, { mode: 0o700 });
            await rename(join(movedParent, "evidence"), root);
          },
        },
      ),
    ).rejects.toBeInstanceOf(AcceptanceEvidenceError);

    expect((await readFile(join(root, "manifest.json"))).byteLength).toBe(0);
  });

  it("bounds reads, confines result paths, and keeps paths and content out of errors", async () => {
    const root = await privateDirectory("docsfab-acceptance-evidence-errors-");
    const path = join(root, "PRIVATE_PATH_SENTINEL.json");
    await writeFile(path, "MODEL_OUTPUT_SENTINEL", { mode: 0o600 });
    const pinned = await pinAcceptanceEvidenceDirectory(root);

    let error: unknown;
    try {
      await readAcceptanceJsonLeaf(pinned, basename(path), { maximumBytes: 1 });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AcceptanceEvidenceError);
    expect(String(error)).not.toContain("PRIVATE_PATH_SENTINEL");
    expect(String(error)).not.toContain("MODEL_OUTPUT_SENTINEL");
    expect(() => acceptanceJsonLeafForPath(pinned, join(root, "result.json"))).not.toThrow();
    expect(() => acceptanceJsonLeafForPath(pinned, join(root, "..", "result.json"))).toThrowError(
      new AcceptanceEvidenceError("unsafe-entry"),
    );
    expect(() =>
      acceptanceJsonLeafForPath(pinned, join(root, "nested", "result.json")),
    ).toThrowError(new AcceptanceEvidenceError("unsafe-entry"));
  });

  it("makes the judge reject substituted records before loading model configuration", async () => {
    const parent = await roots.create("docsfab-acceptance-judge-evidence-");
    const state = join(parent, "PRIVATE_STATE_PATH_SENTINEL");
    const evidence = join(parent, "evidence");
    await mkdir(state, { mode: 0o700 });
    await mkdir(evidence, { mode: 0o700 });
    const external = join(parent, "external.json");
    await writeFile(external, "MODEL_OUTPUT_SENTINEL\n", { mode: 0o600 });
    await symlink(external, join(state, "record.json"));
    const modulePath = fileURLToPath(new URL("../src/acceptance-judge.ts", import.meta.url));

    let stderr = "";
    try {
      await execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx",
          modulePath,
          "--state-dir",
          state,
          "--result",
          join(evidence, "judge-result.json"),
          "--acceptance-id",
          "acceptance-test",
          "--commit",
          "a".repeat(40),
          "--profile-status",
          "current",
        ],
        {
          cwd: resolve(dirname(modulePath), ".."),
          env: { PATH: process.env.PATH },
        },
      );
    } catch (error) {
      stderr = String((error as { stderr?: string }).stderr ?? "");
    }
    expect(stderr).toContain("Acceptance evidence failed (unsafe-entry).");
    expect(stderr).not.toContain("PRIVATE_STATE_PATH_SENTINEL");
    expect(stderr).not.toContain("MODEL_OUTPUT_SENTINEL");
  }, 15_000);
});

async function privateDirectory(prefix: string): Promise<string> {
  const parent = await roots.create(prefix);
  const root = join(parent, "private");
  await mkdir(root, { mode: 0o700 });
  return root;
}
import { execFile } from "node:child_process";
