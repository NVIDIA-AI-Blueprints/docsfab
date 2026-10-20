// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Privacy boundary for product-owned local state namespaces. */
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export class PrivateStateError extends Error {
  public readonly code = "private-state-unsafe";
  public readonly nextAction =
    "Stop writers, back up the complete state parent, repair or move the owned state, then retry.";

  public constructor(public readonly path: string) {
    super(
      `Private state is unsafe at ${path}. Stop writers, back up and repair or move the owned state, or select a fresh private root. Retained files have not been removed.`,
    );
    this.name = "PrivateStateError";
  }
}

type DirectoryPin = {
  path: string;
  dev: number;
  ino: number;
  uid: number;
  mode: number;
  symlink: boolean;
};

function notFound(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

async function osAlias(path: string): Promise<boolean> {
  if (process.platform !== "darwin" || (path !== "/var" && path !== "/tmp")) return false;
  return (await realpath(path).catch(() => "")) === `/private${path}`;
}

function ancestorPaths(target: string): string[] {
  const paths: string[] = [];
  let cursor = resolve(target);
  while (true) {
    paths.push(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return paths.reverse();
}

function privateSegment(path: string, from: string): boolean {
  return path === from || path.startsWith(`${from}${sep}`);
}

async function pin(path: string, stat: Stats): Promise<DirectoryPin> {
  const symlink = stat.isSymbolicLink();
  if ((symlink && !(await osAlias(path))) || (!symlink && !stat.isDirectory())) {
    throw new PrivateStateError(path);
  }
  return { path, dev: stat.dev, ino: stat.ino, uid: stat.uid, mode: stat.mode, symlink };
}

async function verifyPins(pins: readonly DirectoryPin[]): Promise<void> {
  for (const expected of pins) {
    const current = await lstat(expected.path).catch(() => {
      throw new PrivateStateError(expected.path);
    });
    if (
      current.dev !== expected.dev ||
      current.ino !== expected.ino ||
      current.uid !== expected.uid ||
      current.mode !== expected.mode ||
      current.isSymbolicLink() !== expected.symlink ||
      (expected.symlink && !(await osAlias(expected.path)))
    )
      throw new PrivateStateError(expected.path);
  }
}

/** Create missing ancestors privately; require the named namespace private. */
export async function ensurePrivateStateDirectory(
  target: string,
  privateFrom: string = target,
): Promise<void> {
  const absolute = resolve(target);
  const boundary = resolve(privateFrom);
  if (!privateSegment(absolute, boundary)) throw new PrivateStateError(absolute);
  if (typeof process.getuid !== "function" || typeof constants.O_NOFOLLOW !== "number") {
    throw new PrivateStateError(absolute);
  }
  const pins: DirectoryPin[] = [];
  for (const path of ancestorPaths(absolute)) {
    let stat = await lstat(path).catch((error: unknown) => {
      if (notFound(error)) return undefined;
      throw error;
    });
    const created = !stat;
    if (created) {
      await mkdir(path, { mode: PRIVATE_DIRECTORY_MODE });
      stat = await lstat(path);
    }
    const saved = await pin(path, stat!);
    if (created || privateSegment(path, boundary)) {
      if (
        saved.symlink ||
        saved.uid !== process.getuid() ||
        (saved.mode & 0o7777) !== PRIVATE_DIRECTORY_MODE
      ) {
        throw new PrivateStateError(path);
      }
      const handle = await open(
        path,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        const descriptor = await handle.stat();
        if (
          descriptor.dev !== saved.dev ||
          descriptor.ino !== saved.ino ||
          descriptor.uid !== saved.uid ||
          descriptor.mode !== saved.mode
        ) {
          throw new PrivateStateError(path);
        }
      } finally {
        await handle.close();
      }
    }
    pins.push(saved);
  }
  await verifyPins(pins);
}

/** Read an existing private file through a pinned, no-follow descriptor. */
export async function readPrivateStateFile(path: string): Promise<Buffer> {
  const entry = await lstat(path).catch(() => {
    throw new PrivateStateError(path);
  });
  if (
    !entry.isFile() ||
    entry.isSymbolicLink() ||
    entry.nlink !== 1 ||
    entry.uid !== process.getuid?.() ||
    (entry.mode & 0o7777) !== PRIVATE_FILE_MODE
  ) {
    throw new PrivateStateError(path);
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const pinned = await handle.stat();
    if (
      !pinned.isFile() ||
      pinned.nlink !== 1 ||
      pinned.dev !== entry.dev ||
      pinned.ino !== entry.ino ||
      pinned.uid !== entry.uid ||
      pinned.mode !== entry.mode
    ) {
      throw new PrivateStateError(path);
    }
    const current = await lstat(path).catch(() => {
      throw new PrivateStateError(path);
    });
    if (current.dev !== entry.dev || current.ino !== entry.ino || current.mode !== entry.mode) {
      throw new PrivateStateError(path);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
