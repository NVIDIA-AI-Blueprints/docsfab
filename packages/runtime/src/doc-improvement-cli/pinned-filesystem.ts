// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { sha256 } from "../content-ir/canonical.js";
import { parsePrivateJsonEvidence } from "../operator/json-evidence.js";
import { isRecord } from "../shared/primitives.js";
import { sameStat } from "./npm-runtime.js";

interface FsNodeIdentity {
  path: string;
  dev: number;
  ino: number;
  uid: number;
  mode: number;
  nlink: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

interface StableFileIdentity extends FsNodeIdentity {
  sha256: string;
}

export interface DirectoryTreeIdentity {
  path: string;
  root: FsNodeIdentity;
  treeSha256: string;
}

interface GitControlIdentity {
  root: FsNodeIdentity;
  gitDirectory: FsNodeIdentity;
  config: StableFileIdentity;
  head: StableFileIdentity;
  index: StableFileIdentity;
  objects: DirectoryTreeIdentity;
}

interface PinnedNpmCacheCapsule {
  path: string;
  campaignId: string;
  contentSha256: string;
  identity: DirectoryTreeIdentity;
}

interface ImmutableConfigLeaf extends StableFileIdentity {}

export async function pinDirectoryTree(
  path: string,
  requiredRootMode?: number,
): Promise<DirectoryTreeIdentity> {
  const canonical = await realpath(path);
  const root = await nodeIdentity(canonical, "directory");
  if (requiredRootMode !== undefined && (root.mode & 0o7777) !== requiredRootMode) {
    throw new Error("Pinned directory has an unsafe mode.");
  }
  return { path: canonical, root, treeSha256: await directoryTreeDigest(canonical) };
}

export async function assertDirectoryTree(expected: DirectoryTreeIdentity): Promise<void> {
  await assertNodeIdentity(expected.root, "directory");
  if (
    (await realpath(expected.path)) !== expected.path ||
    (await directoryTreeDigest(expected.path)) !== expected.treeSha256
  ) {
    throw new Error("Pinned directory tree changed.");
  }
}

export async function assertDirectoryIdentity(expected: DirectoryTreeIdentity): Promise<void> {
  await assertNodeIdentity(expected.root, "directory");
  if ((await realpath(expected.path)) !== expected.path) {
    throw new Error("Pinned directory identity changed.");
  }
}

async function directoryTreeDigest(root: string): Promise<string> {
  const hash = createHash("sha256");
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const before = await lstat(absolute);
      if (
        before.isSymbolicLink() ||
        (!before.isDirectory() && !before.isFile()) ||
        (uid !== undefined && before.uid !== uid)
      ) {
        throw new Error("Pinned directory contains an unsafe entry.");
      }
      const kind = before.isDirectory() ? "directory" : "file";
      hash.update(
        JSON.stringify([
          relativePath,
          kind,
          before.dev,
          before.ino,
          before.uid,
          before.mode,
          before.nlink,
          before.size,
          before.mtimeMs,
          before.ctimeMs,
        ]),
      );
      if (before.isFile()) {
        const bytes = await readFile(absolute);
        const after = await lstat(absolute);
        if (!sameStat(before, after)) throw new Error("Pinned directory entry changed while read.");
        hash.update(sha256(bytes));
      } else {
        await visit(absolute, relativePath);
      }
      hash.update("\n");
    }
  };
  await visit(root, "");
  return hash.digest("hex");
}

async function nodeIdentity(path: string, kind: "directory" | "file"): Promise<FsNodeIdentity> {
  const value = await lstat(path);
  if (value.isSymbolicLink() || (kind === "directory" ? !value.isDirectory() : !value.isFile())) {
    throw new Error("Filesystem identity has an unsafe type.");
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && value.uid !== uid)
    throw new Error("Filesystem identity has another owner.");
  return {
    path,
    dev: value.dev,
    ino: value.ino,
    uid: value.uid,
    mode: value.mode,
    nlink: value.nlink,
    size: value.size,
    mtimeMs: value.mtimeMs,
    ctimeMs: value.ctimeMs,
  };
}

async function assertNodeIdentity(
  expected: FsNodeIdentity,
  kind: "directory" | "file",
): Promise<void> {
  const actual = await nodeIdentity(expected.path, kind);
  if (!sameNodeIdentity(actual, expected)) throw new Error("Filesystem identity changed.");
}

function sameNodeIdentity(left: FsNodeIdentity, right: FsNodeIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

async function pinStableFile(path: string): Promise<StableFileIdentity> {
  const identity = await nodeIdentity(path, "file");
  if (identity.nlink !== 1) throw new Error("Pinned file is hard-linked.");
  const bytes = await readFile(path);
  await assertNodeIdentity(identity, "file");
  return { ...identity, sha256: sha256(bytes) };
}

async function assertStableFile(expected: StableFileIdentity): Promise<void> {
  await assertNodeIdentity(expected, "file");
  if (sha256(await readFile(expected.path)) !== expected.sha256) {
    throw new Error("Pinned file content changed.");
  }
  await assertNodeIdentity(expected, "file");
}

export async function pinGitControl(
  root: string,
  gitDirectory: string,
): Promise<GitControlIdentity> {
  return {
    root: await nodeIdentity(root, "directory"),
    gitDirectory: await nodeIdentity(gitDirectory, "directory"),
    config: await pinStableFile(join(gitDirectory, "config")),
    head: await pinStableFile(join(gitDirectory, "HEAD")),
    index: await pinStableFile(join(gitDirectory, "index")),
    objects: await pinDirectoryTree(join(gitDirectory, "objects")),
  };
}

export async function assertGitControlEnvelope(
  expected: GitControlIdentity,
  allowed: { allowIndex?: boolean; allowObjects?: boolean } = {},
): Promise<void> {
  await assertNodeEnvelope(expected.root, "directory");
  await assertNodeEnvelope(expected.gitDirectory, "directory");
  await assertStableFile(expected.config);
  await assertStableFile(expected.head);
  if (!allowed.allowIndex) await assertStableFile(expected.index);
  if (!allowed.allowObjects) await assertDirectoryTree(expected.objects);
}

async function assertNodeEnvelope(
  expected: FsNodeIdentity,
  kind: "directory" | "file",
): Promise<void> {
  const actual = await nodeIdentity(expected.path, kind);
  if (
    actual.dev !== expected.dev ||
    actual.ino !== expected.ino ||
    actual.uid !== expected.uid ||
    actual.mode !== expected.mode ||
    actual.nlink !== expected.nlink
  ) {
    throw new Error("Filesystem control envelope changed.");
  }
}

export async function createImmutableNpmConfigLeaves(
  scratchPath: string,
): Promise<{ user: ImmutableConfigLeaf; global: ImmutableConfigLeaf }> {
  const userPath = join(scratchPath, "npm-user-empty.conf");
  const globalPath = join(scratchPath, "npm-global-empty.conf");
  await writeFile(userPath, "", { flag: "wx", mode: 0o400 });
  await writeFile(globalPath, "", { flag: "wx", mode: 0o400 });
  const user = await pinStableFile(userPath);
  const global = await pinStableFile(globalPath);
  if (user.ino === global.ino || user.path === global.path) {
    throw new Error("Npm user and global configuration leaves must be distinct.");
  }
  return { user, global };
}

export async function assertImmutableLeaf(expected: ImmutableConfigLeaf): Promise<void> {
  if (
    (expected.mode & 0o7777) !== 0o400 ||
    expected.size !== 0 ||
    expected.sha256 !== sha256(Buffer.alloc(0))
  ) {
    throw new Error("Npm configuration leaf is not immutable and empty.");
  }
  await assertStableFile(expected);
}

const NPM_CACHE_MANIFEST = "docsfab-npm-cache.json";

export async function pinNpmCacheCapsule(
  path: string,
  campaignId: string,
): Promise<PinnedNpmCacheCapsule> {
  const canonical = await realpath(resolve(path));
  const contentSha256 = await npmCacheContentDigest(canonical);
  if (basename(canonical) !== `sha256-${contentSha256}`) {
    throw new Error("Documentation improvement npm cache capsule is not content-addressed.");
  }
  const manifestFile = await pinStableFile(join(canonical, NPM_CACHE_MANIFEST));
  if ((manifestFile.mode & 0o7777) !== 0o400) {
    throw new Error("Documentation improvement npm cache manifest is mutable.");
  }
  let manifest: unknown;
  try {
    manifest = parsePrivateJsonEvidence(await readFile(manifestFile.path));
  } catch {
    throw new Error("Documentation improvement npm cache manifest is invalid.");
  }
  if (
    !isRecord(manifest) ||
    Object.keys(manifest).sort().join(",") !== "campaignId,contentSha256,kind,schemaVersion" ||
    manifest.schemaVersion !== 1 ||
    manifest.kind !== "doc-improvement-npm-cache" ||
    manifest.campaignId !== campaignId ||
    manifest.contentSha256 !== contentSha256
  ) {
    throw new Error("Documentation improvement npm cache capsule is not campaign-bound.");
  }
  const identity = await pinDirectoryTree(canonical, 0o500);
  return { path: canonical, campaignId, contentSha256, identity };
}

export async function assertNpmCacheCapsule(expected: PinnedNpmCacheCapsule): Promise<void> {
  await assertDirectoryTree(expected.identity);
  if ((await npmCacheContentDigest(expected.path)) !== expected.contentSha256) {
    throw new Error("Documentation improvement npm cache capsule changed.");
  }
}

async function npmCacheContentDigest(root: string): Promise<string> {
  const entries: Array<{
    path: string;
    kind: "directory" | "file";
    byteLength?: number;
    sha256?: string;
  }> = [];
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      if (prefix === "" && child.name === NPM_CACHE_MANIFEST) continue;
      const absolute = join(directory, child.name);
      const relativePath = prefix ? `${prefix}/${child.name}` : child.name;
      const before = await lstat(absolute);
      if (before.isSymbolicLink() || (uid !== undefined && before.uid !== uid)) {
        throw new Error("Documentation improvement npm cache capsule has an unsafe entry.");
      }
      if (before.isDirectory()) {
        if ((before.mode & 0o7777) !== 0o500) {
          throw new Error("Documentation improvement npm cache directory is mutable.");
        }
        entries.push({ path: relativePath, kind: "directory" });
        await visit(absolute, relativePath);
      } else if (before.isFile()) {
        if ((before.mode & 0o7777) !== 0o400 || before.nlink !== 1) {
          throw new Error("Documentation improvement npm cache file is mutable or linked.");
        }
        const bytes = await readFile(absolute);
        const after = await lstat(absolute);
        if (!sameStat(before, after)) {
          throw new Error("Documentation improvement npm cache entry changed while read.");
        }
        entries.push({
          path: relativePath,
          kind: "file",
          byteLength: bytes.byteLength,
          sha256: sha256(bytes),
        });
      } else {
        throw new Error("Documentation improvement npm cache capsule has an unsafe entry type.");
      }
    }
  };
  await visit(root, "");
  return sha256(Buffer.from(JSON.stringify(entries)));
}
