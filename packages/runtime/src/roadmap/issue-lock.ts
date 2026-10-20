// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SHA256 = /^[a-f0-9]{64}$/u;
const OWNER = "owner.json";
const TAKEOVER = "takeover";

export interface IssueLifecycleApplyLock {
  runExclusive<T>(key: string, action: () => Promise<T>): Promise<T>;
}

export class IssueLifecycleLockError extends Error {
  public constructor(public readonly code: "lock-active" | "lock-invalid" | "lock-failed") {
    super(`Issue lifecycle apply lock failed (${code}).`);
    this.name = "IssueLifecycleLockError";
  }
}

/** Host-only, process-safe local lease. A verified dead owner is quarantined before reacquisition. */
export class FileIssueLifecycleApplyLock implements IssueLifecycleApplyLock {
  private readonly root: string;
  public constructor(options: { root?: string; incompleteStaleAfterMs?: number } = {}) {
    const uid = currentUid();
    this.root = resolve(options.root ?? join(tmpdir(), `docsfab-issue-locks-${uid}`));
    this.incompleteStaleAfterMs = options.incompleteStaleAfterMs ?? 30_000;
    if (!Number.isFinite(this.incompleteStaleAfterMs) || this.incompleteStaleAfterMs < 0) {
      throw new IssueLifecycleLockError("lock-invalid");
    }
  }
  private readonly incompleteStaleAfterMs: number;

  public async runExclusive<T>(key: string, action: () => Promise<T>): Promise<T> {
    if (!SHA256.test(key)) throw new IssueLifecycleLockError("lock-invalid");
    await this.prepareRoot();
    const lockDirectory = join(this.root, `${key}.lock`);
    const nonce = randomUUID();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await mkdir(lockDirectory, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST")
          throw new IssueLifecycleLockError("lock-failed");
        await this.reclaimIfDead(lockDirectory);
        continue;
      }
      try {
        await writeOwner(join(lockDirectory, OWNER), nonce);
      } catch {
        await unlink(join(lockDirectory, OWNER)).catch(() => undefined);
        await rmdir(lockDirectory).catch(() => undefined);
        throw new IssueLifecycleLockError("lock-failed");
      }
      return runOwned(lockDirectory, nonce, action);
    }
    throw new IssueLifecycleLockError("lock-active");
  }

  private async prepareRoot(): Promise<void> {
    try {
      await mkdir(this.root, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST")
        throw new IssueLifecycleLockError("lock-failed");
    }
    const state = await lstat(this.root);
    if (
      !state.isDirectory() ||
      state.isSymbolicLink() ||
      (state.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && state.uid !== process.getuid())
    ) {
      throw new IssueLifecycleLockError("lock-invalid");
    }
  }

  private async reclaimIfDead(lockDirectory: string): Promise<void> {
    const state = await lstat(lockDirectory).catch(() => undefined);
    if (!state) return;
    if (
      !state.isDirectory() ||
      state.isSymbolicLink() ||
      (state.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && state.uid !== process.getuid())
    ) {
      throw new IssueLifecycleLockError("lock-invalid");
    }
    const owner = await readOwner(join(lockDirectory, OWNER)).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        if (Date.now() - state.mtimeMs >= this.incompleteStaleAfterMs) return undefined;
        throw new IssueLifecycleLockError("lock-active");
      }
      if (
        error instanceof IssueLifecycleLockError &&
        error.code === "lock-invalid" &&
        Date.now() - state.mtimeMs >= this.incompleteStaleAfterMs
      )
        return undefined;
      throw error;
    });
    if (owner && processAlive(owner.pid)) throw new IssueLifecycleLockError("lock-active");
    const takeoverPath = join(lockDirectory, TAKEOVER);
    try {
      const handle = await open(
        takeoverPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(),
        0o600,
      );
      try {
        await handle.writeFile(randomUUID(), "utf8");
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === "EEXIST" ||
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        throw new IssueLifecycleLockError("lock-active");
      }
      throw new IssueLifecycleLockError("lock-invalid");
    }
    const confirmed = await readOwner(join(lockDirectory, OWNER)).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && owner === undefined)
        return undefined;
      if (
        error instanceof IssueLifecycleLockError &&
        error.code === "lock-invalid" &&
        owner === undefined
      )
        return undefined;
      throw error;
    });
    if (
      (owner && (!confirmed || confirmed.nonce !== owner.nonce || processAlive(confirmed.pid))) ||
      (!owner && confirmed)
    )
      throw new IssueLifecycleLockError("lock-active");
    const quarantine = `${lockDirectory}.stale.${randomUUID()}`;
    await rename(lockDirectory, quarantine);
    await unlink(join(quarantine, OWNER)).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
    await unlink(join(quarantine, TAKEOVER));
    await rmdir(quarantine);
  }
}

async function runOwned<T>(
  lockDirectory: string,
  nonce: string,
  action: () => Promise<T>,
): Promise<T> {
  let actionError: unknown;
  let actionFailed = false;
  let value: T | undefined;
  try {
    value = await action();
  } catch (error) {
    actionFailed = true;
    actionError = error;
  }
  try {
    await releaseOwned(lockDirectory, nonce);
  } catch (releaseError) {
    if (!actionFailed) throw releaseError;
  }
  if (actionFailed) throw actionError;
  return value as T;
}

interface Owner {
  schemaVersion: 1;
  pid: number;
  uid: number;
  nonce: string;
  createdAt: string;
}

async function writeOwner(path: string, nonce: string): Promise<void> {
  const value: Owner = {
    schemaVersion: 1,
    pid: process.pid,
    uid: currentUid(),
    nonce,
    createdAt: new Date().toISOString(),
  };
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(),
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readOwner(path: string): Promise<Owner> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | noFollowFlag());
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.size < 2n ||
      before.size > 1024n ||
      before.nlink !== 1n ||
      (before.mode & 0o077n) !== 0n ||
      (typeof process.getuid === "function" && before.uid !== BigInt(process.getuid()))
    ) {
      throw new IssueLifecycleLockError("lock-invalid");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      bytes.byteLength !== Number(before.size) ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) {
      throw new IssueLifecycleLockError("lock-invalid");
    }
    let parsed: Partial<Owner>;
    try {
      parsed = JSON.parse(bytes.toString("utf8")) as Partial<Owner>;
    } catch {
      throw new IssueLifecycleLockError("lock-invalid");
    }
    if (
      parsed.schemaVersion !== 1 ||
      !Number.isSafeInteger(parsed.pid) ||
      Number(parsed.pid) < 1 ||
      parsed.uid !== currentUid() ||
      typeof parsed.nonce !== "string" ||
      !/^[a-f0-9-]{36}$/u.test(parsed.nonce) ||
      typeof parsed.createdAt !== "string" ||
      Number.isNaN(Date.parse(parsed.createdAt))
    ) {
      throw new IssueLifecycleLockError("lock-invalid");
    }
    return parsed as Owner;
  } finally {
    await handle.close();
  }
}

async function releaseOwned(lockDirectory: string, nonce: string): Promise<void> {
  const owner = await readOwner(join(lockDirectory, OWNER));
  if (owner.nonce !== nonce || owner.pid !== process.pid)
    throw new IssueLifecycleLockError("lock-invalid");
  await unlink(join(lockDirectory, OWNER));
  await rmdir(lockDirectory);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function currentUid(): number {
  return typeof process.getuid === "function" ? process.getuid() : 0;
}
function noFollowFlag(): number {
  return constants.O_NOFOLLOW ?? 0;
}
