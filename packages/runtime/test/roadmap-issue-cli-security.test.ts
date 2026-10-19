// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { persistPrivateJsonFile, readPrivateJsonFile } from "../src/roadmap/issue-cli.js";
import { SecurePathAuthority } from "../src/roadmap/secure-path.js";

const executeFile = promisify(execFile);

interface SuiteRoot {
  path: string;
  dev: bigint;
  ino: bigint;
}

let suiteRoot: SuiteRoot | undefined;

describe("private issue lifecycle JSON input", () => {
  beforeAll(async () => {
    suiteRoot = await createSuiteRoot();
  });

  afterAll(async () => {
    if (suiteRoot !== undefined) await removeSuiteRoot(suiteRoot);
  });

  it("reads one bounded owner-only regular file", async () => {
    const root = await privateRoot();
    const path = join(root, "input.json");
    await writeFile(path, '{"value":"safe"}\n', { mode: 0o600 });
    await expect(readPrivateJsonFile(path, "/")).resolves.toEqual({ value: "safe" });
  });

  it("rejects permissive files, hardlinks, symlinks, FIFOs, and oversized files", async () => {
    const root = await privateRoot();
    const path = join(root, "input.json");
    await writeFile(path, '{"value":"safe"}\n', { mode: 0o600 });
    await chmod(path, 0o640);
    await expect(readPrivateJsonFile(path, "/")).rejects.toThrow("private owner-only");
    await chmod(path, 0o600);

    const hardlink = join(root, "hardlink.json");
    await link(path, hardlink);
    await expect(readPrivateJsonFile(path, "/")).rejects.toThrow("private owner-only");

    const target = join(root, "target.json");
    await writeFile(target, '{"value":"target"}\n', { mode: 0o600 });
    const linked = join(root, "linked.json");
    await symlink(target, linked);
    await expect(readPrivateJsonFile(linked, "/")).rejects.toThrow();

    const fifo = join(root, "input.fifo");
    await executeFile("mkfifo", [fifo]);
    await expect(readPrivateJsonFile(fifo, "/")).rejects.toThrow("private owner-only");

    const oversized = join(root, "oversized.json");
    const handle = await open(oversized, "w", 0o600);
    try {
      await handle.truncate(2 * 1024 * 1024 + 1);
    } finally {
      await handle.close();
    }
    await expect(readPrivateJsonFile(oversized, "/")).rejects.toThrow("private owner-only");
  });

  it("rejects a pathname swap after binding the opened inode", async () => {
    const root = await privateRoot();
    const path = join(root, "input.json");
    const moved = join(root, "opened.json");
    const replacement = join(root, "replacement.json");
    await writeFile(path, '{"value":"opened"}\n', { mode: 0o600 });
    await writeFile(replacement, '{"value":"replacement"}\n', { mode: 0o600 });
    await expect(
      readPrivateJsonFile(path, "/", {
        afterStat: async () => {
          await rename(path, moved);
          await symlink(replacement, path);
        },
      }),
    ).rejects.toThrow("changed while it was read");
  });

  it("rejects in-place mutation between stat and read", async () => {
    const root = await privateRoot();
    const path = join(root, "input.json");
    await writeFile(path, '{"value":"first"}\n', { mode: 0o600 });
    await expect(
      readPrivateJsonFile(path, "/", {
        afterStat: async () => {
          await writeFile(path, '{"value":"other-mutated"}\n', { mode: 0o600 });
        },
      }),
    ).rejects.toThrow("changed while it was read");
  });

  it("rejects a linked ancestor instead of following it to an input", async () => {
    const root = await privateRoot();
    const target = await mkdtemp(join(root, "target-"));
    const linked = join(root, "linked");
    await writeFile(join(target, "input.json"), '{"value":"target"}\n', { mode: 0o600 });
    await symlink(target, linked);
    await expect(readPrivateJsonFile(join(linked, "input.json"), "/")).rejects.toThrow(
      "Symbolic-link parent",
    );
  });

  it("rejects a linked receipt parent before creating a temporary or final file", async () => {
    const root = await privateRoot();
    const target = await mkdtemp(join(root, "target-"));
    const linked = join(root, "linked");
    await symlink(target, linked);
    await expect(
      persistPrivateJsonFile(join(linked, "receipt.json"), { value: "unsafe" }),
    ).rejects.toThrow("Symbolic-link parent");
    expect(await readdir(target)).toEqual([]);
  });

  it("creates private receipt parents and atomically publishes owner-only JSON", async () => {
    const root = await privateRoot();
    const path = join(root, "new", "nested", "receipt.json");
    await persistPrivateJsonFile(path, { value: "safe" });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ value: "safe" });
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect((await lstat(join(root, "new"))).mode & 0o777).toBe(0o700);
    expect((await lstat(join(root, "new", "nested"))).mode & 0o777).toBe(0o700);
  });

  it("rejects read and receipt parent substitutions after pinning the chain", async () => {
    const readRoot = await privateRoot();
    const readMoved = `${readRoot}.moved`;
    await writeFile(join(readRoot, "input.json"), '{"value":"opened"}\n', { mode: 0o600 });
    await expect(
      readPrivateJsonFile(join(readRoot, "input.json"), "/", {
        afterParentPin: async () => {
          await rename(readRoot, readMoved);
          await symlink(readMoved, readRoot);
        },
      }),
    ).rejects.toThrow("Parent path changed");

    const writeRoot = await privateRoot();
    const writeMoved = `${writeRoot}.moved`;
    await expect(
      persistPrivateJsonFile(
        join(writeRoot, "receipt.json"),
        { value: "unsafe" },
        {
          afterParentPin: async () => {
            await rename(writeRoot, writeMoved);
            await symlink(writeMoved, writeRoot);
          },
        },
      ),
    ).rejects.toThrow("Parent path changed");
    expect(await readdir(writeMoved)).toEqual([]);
  });

  it("rejects receipt parent substitutions after temp creation and after final rename", async () => {
    const beforeRenameRoot = await privateRoot();
    const beforeRenameMoved = `${beforeRenameRoot}.moved`;
    await expect(
      persistPrivateJsonFile(
        join(beforeRenameRoot, "receipt.json"),
        { value: "unsafe" },
        {
          afterTemporaryOpen: async () => {
            await rename(beforeRenameRoot, beforeRenameMoved);
            await symlink(beforeRenameMoved, beforeRenameRoot);
          },
        },
      ),
    ).rejects.toThrow("Parent path changed");
    expect((await readdir(beforeRenameMoved)).some((name) => name === "receipt.json")).toBe(false);

    const afterRenameRoot = await privateRoot();
    const afterRenameMoved = `${afterRenameRoot}.moved`;
    await expect(
      persistPrivateJsonFile(
        join(afterRenameRoot, "receipt.json"),
        { value: "unsafe" },
        {
          afterRename: async () => {
            await rename(afterRenameRoot, afterRenameMoved);
            await symlink(afterRenameMoved, afterRenameRoot);
          },
        },
      ),
    ).rejects.toThrow("Parent path changed");
    expect(JSON.parse(await readFile(join(afterRenameMoved, "receipt.json"), "utf8"))).toEqual({
      value: "unsafe",
    });
  });

  it("never cleans up through a substituted parent with an outside same-basename sentinel", async () => {
    const root = await privateRoot();
    const moved = `${root}.moved`;
    let sentinel = "";
    await expect(
      persistPrivateJsonFile(
        join(root, "receipt.json"),
        { value: "safe" },
        {
          beforeRename: async ({ temporaryPath }) => {
            await rename(root, moved);
            await mkdir(root, { mode: 0o700 });
            sentinel = join(root, basename(temporaryPath));
            await writeFile(sentinel, "outside-sentinel", { mode: 0o600 });
          },
        },
      ),
    ).rejects.toThrow("Parent path changed");
    expect(await readFile(sentinel, "utf8")).toBe("outside-sentinel");
    const trustedTemporary = (await readdir(moved)).find((name) => name.endsWith(".tmp"));
    expect(trustedTemporary).toBeDefined();
    expect(JSON.parse(await readFile(join(moved, trustedTemporary!), "utf8"))).toEqual({
      value: "safe",
    });
    expect(await readdir(root)).toEqual([basename(sentinel)]);
  });

  it("rejects same-inode receipt overwrites after rename and before directory sync", async () => {
    const afterRenameRoot = await privateRoot();
    let afterRenameReturned = false;
    let afterRenameSameInode = false;
    await expect(
      persistPrivateJsonFile(
        join(afterRenameRoot, "receipt.json"),
        { value: "safe" },
        {
          afterRename: async ({ path }) => {
            const before = await lstat(path, { bigint: true });
            await writeFile(path, '{"value":"evil"}\n', { mode: 0o600 });
            const after = await lstat(path, { bigint: true });
            afterRenameSameInode = before.dev === after.dev && before.ino === after.ino;
          },
        },
      ).then(() => {
        afterRenameReturned = true;
      }),
    ).rejects.toThrow();
    expect(afterRenameReturned).toBe(false);
    expect(afterRenameSameInode).toBe(true);

    const beforeSyncRoot = await privateRoot();
    let beforeSyncReturned = false;
    let beforeSyncSameInode = false;
    await expect(
      persistPrivateJsonFile(
        join(beforeSyncRoot, "receipt.json"),
        { value: "safe" },
        {
          beforeDirectorySync: async ({ path }) => {
            const before = await lstat(path, { bigint: true });
            await writeFile(path, '{"value":"evil"}\n', { mode: 0o600 });
            const after = await lstat(path, { bigint: true });
            beforeSyncSameInode = before.dev === after.dev && before.ino === after.ino;
          },
        },
      ).then(() => {
        beforeSyncReturned = true;
      }),
    ).rejects.toThrow();
    expect(beforeSyncReturned).toBe(false);
    expect(beforeSyncSameInode).toBe(true);
  });

  it("rejects permissive parent directories", async () => {
    const root = await privateRoot();
    const parent = await mkdtemp(join(root, "permissive-"));
    await writeFile(join(parent, "input.json"), '{"value":"unsafe"}\n', { mode: 0o600 });
    await chmod(parent, 0o777);
    await expect(readPrivateJsonFile(join(parent, "input.json"), "/")).rejects.toThrow(
      "stable private parent",
    );
  });
});

async function privateRoot(): Promise<string> {
  if (suiteRoot === undefined) throw new Error("Private JSON suite root is not initialized.");
  return mkdtemp(join(suiteRoot.path, "docsfab-private-json-"));
}

async function createSuiteRoot(): Promise<SuiteRoot> {
  // SecurePathAuthority rejects any world/group-writable ancestor, including
  // /tmp. Validate the complete chain before allocating beneath a caller
  // supplied CI base, the platform temporary base, or a home-cache fallback.
  const candidates = [
    { path: process.env.DOCSFAB_TEST_TRUSTED_ROOT, createParents: false },
    { path: tmpdir(), createParents: false },
    { path: join(homedir(), ".cache", "docsfab-test-private"), createParents: true },
  ].filter(
    (candidate): candidate is { path: string; createParents: boolean } =>
      typeof candidate.path === "string" && candidate.path.length > 0,
  );

  const errors: string[] = [];
  for (const candidate of candidates) {
    try {
      if (candidate.createParents)
        await SecurePathAuthority.bind(join(candidate.path, ".docsfab-private-json-authority"), {
          createParents: true,
        });
      const base = await realpath(candidate.path);
      await SecurePathAuthority.bind(join(base, ".docsfab-private-json-authority"));
      const path = await mkdtemp(join(base, "docsfab-private-json-suite-"));
      await chmod(path, 0o700);
      await SecurePathAuthority.bind(join(path, ".docsfab-private-json-authority"));
      const state = await lstat(path, { bigint: true });
      return { path, dev: state.dev, ino: state.ino };
    } catch (error) {
      errors.push(`${candidate.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`No trusted private test root is available (${errors.join("; ")})`);
}

async function removeSuiteRoot(root: SuiteRoot): Promise<void> {
  let state;
  try {
    state = await lstat(root.path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (state.isSymbolicLink()) {
    await unlink(root.path);
    return;
  }
  if (!state.isDirectory() || state.dev !== root.dev || state.ino !== root.ino)
    throw new Error("Private JSON suite root changed before cleanup.");
  await rm(root.path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
