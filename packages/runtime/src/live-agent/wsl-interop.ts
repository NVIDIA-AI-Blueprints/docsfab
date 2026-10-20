// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

export const WSL_INTEROP_FAILURE =
  "DocsFab refused the command (live-command-wsl-interop-unavailable): it could not isolate the WSL Windows bridge. No command ran. Restart the WSL session and retry. If this persists, remove custom bridge mounts or socket links outside DocsFab. Direct documentation edits remain available.";

interface Mount {
  device: string;
  root: string;
  point: string;
}

const within = (root: string, path: string) =>
  path === root || path.startsWith(root === "/" ? root : `${root}/`);

/** The kernel can retain /init; the socket cut must also cover bind aliases. */
export async function wslInteropMounts(): Promise<string[]> {
  try {
    // Only an absent standard bridge preserves ordinary Linux behavior; other I/O errors refuse.
    const bridgeEntry = await lstat("/run/WSL").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!bridgeEntry) return [];
    const bridge = await realpath("/run/WSL");
    const directory = await stat(bridge);
    // Compare the host root owner, including when an outer user namespace maps it to overflowuid.
    const hostOwner = (await stat("/")).uid;
    if (!directory.isDirectory() || directory.uid !== hostOwner || directory.mode & 0o022)
      throw new Error(WSL_INTEROP_FAILURE);
    for (const name of await readdir(bridge)) {
      const path = await realpath(join(bridge, name));
      if (!within(bridge, path)) throw new Error(WSL_INTEROP_FAILURE);
      const entry = await stat(path);
      // New session sockets stay hidden under the directory mask. Hardlinks outside it would not.
      if ((!entry.isSocket() && !entry.isFile()) || (entry.isSocket() && entry.nlink !== 1))
        throw new Error(WSL_INTEROP_FAILURE);
    }
    const mounts = parseMounts(await readFile("/proc/self/mountinfo", "utf8"));
    const masks = new Map<string, boolean>();
    await maskResource(bridge, mounts, masks);
    const init = await lstat("/init").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (init) await maskResource(await realpath("/init"), mounts, masks);
    return [...masks].flatMap(([path, directory]) =>
      directory ? ["--tmpfs", path] : ["--ro-bind", "/dev/null", path],
    );
  } catch {
    // Every observation failure prevents execution beside a bridge we could not conceal.
    throw new Error(WSL_INTEROP_FAILURE);
  }
}

async function maskResource(resource: string, mounts: Mount[], masks: Map<string, boolean>) {
  const containing = mounts.filter((mount) => within(mount.point, resource));
  const longest = Math.max(...containing.map((mount) => mount.point.length));
  const owners = containing.filter((mount) => mount.point.length === longest);
  if (owners.length !== 1) throw new Error(WSL_INTEROP_FAILURE);
  const owner = owners[0]!;
  const root = join(owner.root, relative(owner.point, resource));
  const projected = new Set<string>();
  for (const mount of mounts.filter((mount) => mount.device === owner.device)) {
    let target: string;
    let source: string;
    if (within(mount.root, root)) {
      target = join(mount.point, relative(mount.root, root));
      source = resource;
    } else if (within(root, mount.root)) {
      target = mount.point;
      source = join(resource, relative(root, mount.root));
    } else continue; // A disjoint filesystem subtree exposes none of this resource.
    if (projected.has(target)) throw new Error(WSL_INTEROP_FAILURE);
    projected.add(target);
    const expected = await stat(source);
    const actual = await stat(target);
    if (actual.dev !== expected.dev || actual.ino !== expected.ino)
      throw new Error(WSL_INTEROP_FAILURE);
    if (!actual.isDirectory() && !actual.isFile() && !actual.isSocket())
      throw new Error(WSL_INTEROP_FAILURE);
    masks.set(target, actual.isDirectory());
  }
  if (!projected.has(resource)) throw new Error(WSL_INTEROP_FAILURE);
}

function parseMounts(text: string): Mount[] {
  const mounts: Mount[] = [];
  for (const line of text.trim().split("\n")) {
    const fields = line.split(" ");
    const separator = fields.indexOf("-");
    if (
      separator < 6 ||
      fields.length < separator + 4 ||
      !/^\d+$/u.test(fields[0]!) ||
      !/^\d+$/u.test(fields[1]!) ||
      !/^\d+:\d+$/u.test(fields[2]!)
    )
      throw new Error(WSL_INTEROP_FAILURE);
    mounts.push({ device: fields[2]!, root: mountPath(fields[3]!), point: mountPath(fields[4]!) });
  }
  return mounts;
}

function mountPath(value: string): string {
  // mountinfo escapes space, tab, newline, and backslash; any other escape is unprovable input.
  if (/\\(?!040|011|012|134)/u.test(value)) throw new Error(WSL_INTEROP_FAILURE);
  const path = value.replace(/\\(040|011|012|134)/gu, (_, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
  if (!isAbsolute(path) || path.includes("\0") || resolve(path) !== path)
    throw new Error(WSL_INTEROP_FAILURE);
  return path;
}
