// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { posix, relative, resolve, sep } from "node:path";

import { canonicalDigest } from "../content-ir/index.js";

export interface TemplateWorkspaceManifest {
  directories: string[];
  files: Array<{ path: string; sha256: string; byteLength: number; executable: boolean }>;
  digest: string;
}

/** Content-free identity of every directory and regular file in a workspace. */
export async function captureTemplateWorkspaceManifest(
  workspacePath: string,
): Promise<TemplateWorkspaceManifest> {
  const root = await realpath(resolve(workspacePath));
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("Template workspace manifest requires a real directory.");
  }
  const directories: string[] = [];
  const files: Array<{ path: string; sha256: string; byteLength: number; executable: boolean }> =
    [];
  await visit(root, root, directories, files);
  directories.sort(compareText);
  files.sort((left, right) => compareText(left.path, right.path));
  const value = { directories, files };
  return { ...value, digest: canonicalDigest(value) };
}

export function expectedTemplateWorkspaceManifest(
  baseline: TemplateWorkspaceManifest,
  outputs: readonly { path: string; contentSha256: string; byteLength: number }[],
): TemplateWorkspaceManifest {
  const directories = new Set(baseline.directories);
  const files = new Map(baseline.files.map((file) => [file.path, { ...file }]));
  for (const output of outputs) {
    let parent = posix.dirname(output.path);
    while (parent !== ".") {
      directories.add(parent);
      parent = posix.dirname(parent);
    }
    files.set(output.path, {
      path: output.path,
      sha256: output.contentSha256,
      byteLength: output.byteLength,
      executable: false,
    });
  }
  const value = {
    directories: [...directories].sort(compareText),
    files: [...files.values()].sort((left, right) => compareText(left.path, right.path)),
  };
  return { ...value, digest: canonicalDigest(value) };
}

async function visit(
  root: string,
  directory: string,
  directories: string[],
  files: Array<{ path: string; sha256: string; byteLength: number; executable: boolean }>,
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => compareText(left.name, right.name))) {
    const absolute = resolve(directory, entry.name);
    const path = relative(root, absolute).split(sep).join("/");
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) throw new Error(`Template workspace contains a symlink at ${path}.`);
    if (info.isDirectory()) {
      directories.push(path);
      await visit(root, absolute, directories, files);
    } else if (info.isFile()) {
      const identity = { device: info.dev, inode: info.ino, size: info.size };
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(absolute)) hash.update(chunk as Buffer);
      const after = await lstat(absolute);
      if (
        !after.isFile() ||
        after.isSymbolicLink() ||
        after.dev !== identity.device ||
        after.ino !== identity.inode ||
        after.size !== identity.size
      ) {
        throw new Error(`Template workspace changed while hashing ${path}.`);
      }
      files.push({
        path,
        sha256: hash.digest("hex"),
        byteLength: info.size,
        executable: (info.mode & 0o100) !== 0,
      });
    } else {
      throw new Error(`Template workspace contains an unsupported entry at ${path}.`);
    }
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
