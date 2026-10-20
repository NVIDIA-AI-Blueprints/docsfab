// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { access, lstat, readFile, readdir, readlink, realpath, stat } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, relative } from "node:path";

const MAX_NPM_RUNTIME_ENTRIES = 50_000;

const MAX_NPM_RUNTIME_BYTES = 512 * 1024 * 1024;

export interface ValidationNpmRuntime {
  cliPath: string;
  readOnlyDirectories: string[];
  identities: PinnedValidationRuntimePath[];
  packageRoot: string;
  packageTreeSha256: string;
}

export interface PinnedValidationRuntimePath {
  path: string;
  kind: "file" | "directory";
  device: number;
  inode: number;
  owner: number;
  group: number;
  mode: number;
  size?: number;
  contentSha256?: string;
}

export async function resolveValidationNpmRuntime(): Promise<ValidationNpmRuntime> {
  const configured = process.env.npm_execpath;
  const commandPath =
    configured && isAbsolute(configured) ? configured : await findExecutableOnPath("npm");
  const cliPath = await realpath(commandPath);
  const cli = await lstat(cliPath);
  if (!cli.isFile()) throw new Error("Documentation improvement npm runtime is unavailable.");
  let packageRoot = dirname(cliPath);
  let packageManifestPath: string | undefined;
  while (packageRoot !== "/") {
    const candidateManifestPath = join(packageRoot, "package.json");
    let manifestText: string;
    try {
      manifestText = await readFile(candidateManifestPath, "utf8");
    } catch {
      packageRoot = dirname(packageRoot);
      continue;
    }
    let manifest: { name?: unknown };
    try {
      manifest = JSON.parse(manifestText) as { name?: unknown };
    } catch {
      throw new Error("Documentation improvement npm runtime is unavailable.");
    }
    if (manifest.name !== "npm") {
      throw new Error("Documentation improvement npm runtime is unavailable.");
    }
    packageManifestPath = await realpath(candidateManifestPath);
    break;
  }
  if (packageRoot === "/" || !packageManifestPath) {
    throw new Error("Documentation improvement npm runtime is unavailable.");
  }
  if (typeof process.getuid !== "function" || process.getuid() === 0) {
    throw new Error(
      "Documentation improvement validation requires an unprivileged process and a root-owned npm runtime.",
    );
  }
  const nodeExecutable = await realpath(process.execPath);
  const nodeRuntimeRoot = await realpath(dirname(dirname(nodeExecutable)));
  const readOnlyDirectories = [...new Set([nodeRuntimeRoot, packageRoot])];
  const runtimeFiles = [nodeExecutable, cliPath, packageManifestPath];
  return {
    cliPath,
    readOnlyDirectories,
    packageRoot,
    packageTreeSha256: await validationNpmRuntimeTreeDigest(packageRoot),
    identities: [
      ...(await Promise.all(runtimeFiles.map((path) => pinValidationRuntimePath(path, "file")))),
      ...(await pinValidationRuntimeAncestorChain([...runtimeFiles, ...readOnlyDirectories])),
    ],
  };
}

async function pinValidationRuntimePath(
  path: string,
  kind: PinnedValidationRuntimePath["kind"],
  requiredOwner: number | null = 0,
  enforceEffectiveReadOnly = true,
  enforceSafeMode = true,
): Promise<PinnedValidationRuntimePath> {
  const canonical = await realpath(path);
  if (canonical !== path) throw new Error("Documentation improvement npm runtime is unavailable.");
  const metadata = await stat(path);
  const expectedKind = kind === "file" ? metadata.isFile() : metadata.isDirectory();
  if (
    !expectedKind ||
    (enforceSafeMode && (metadata.mode & 0o022) !== 0) ||
    (requiredOwner !== null && metadata.uid !== requiredOwner)
  ) {
    throw new Error("Documentation improvement npm runtime is unavailable.");
  }
  if (enforceEffectiveReadOnly) await assertNotEffectivelyWritable(path);
  const contentSha256 = kind === "file" ? await stableFileSha256(path, metadata) : undefined;
  return {
    path,
    kind,
    device: metadata.dev,
    inode: metadata.ino,
    owner: metadata.uid,
    group: metadata.gid,
    mode: metadata.mode,
    ...(kind === "file" ? { size: metadata.size, contentSha256 } : {}),
  };
}

export async function pinValidationRuntimeAncestorChain(
  paths: readonly string[],
  requiredOwner: number | null = 0,
  enforceEffectiveReadOnly = true,
  enforceSafeMode = true,
): Promise<PinnedValidationRuntimePath[]> {
  const ancestors = new Set<string>();
  for (const path of paths) {
    const canonical = await realpath(path);
    if (canonical !== path) {
      throw new Error("Documentation improvement npm runtime ancestor is not canonical.");
    }
    const metadata = await stat(path);
    let current = metadata.isDirectory() ? path : dirname(path);
    while (true) {
      ancestors.add(current);
      if (current === "/") break;
      current = dirname(current);
    }
  }
  const ordered = [...ancestors].sort(
    (left, right) => left.split("/").length - right.split("/").length || left.localeCompare(right),
  );
  return Promise.all(
    ordered.map((path) =>
      pinValidationRuntimePath(
        path,
        "directory",
        requiredOwner,
        enforceEffectiveReadOnly,
        enforceSafeMode,
      ),
    ),
  );
}

export async function assertValidationNpmRuntime(runtime: ValidationNpmRuntime): Promise<void> {
  await assertPinnedValidationRuntimePaths(runtime.identities);
  try {
    if ((await validationNpmRuntimeTreeDigest(runtime.packageRoot)) !== runtime.packageTreeSha256) {
      throw new Error("runtime tree changed");
    }
  } catch {
    throw new Error("Documentation improvement npm runtime changed during validation.");
  }
}

export async function assertPinnedValidationRuntimePaths(
  identities: readonly PinnedValidationRuntimePath[],
  enforceEffectiveReadOnly = true,
): Promise<void> {
  for (const expected of identities) {
    try {
      const canonical = await realpath(expected.path);
      const metadata = await stat(expected.path);
      if (
        canonical !== expected.path ||
        metadata.dev !== expected.device ||
        metadata.ino !== expected.inode ||
        metadata.uid !== expected.owner ||
        metadata.gid !== expected.group ||
        metadata.mode !== expected.mode ||
        (expected.kind === "file" ? !metadata.isFile() : !metadata.isDirectory()) ||
        (expected.kind === "file" &&
          (metadata.size !== expected.size ||
            (await stableFileSha256(expected.path, metadata)) !== expected.contentSha256))
      ) {
        throw new Error("runtime identity changed");
      }
      if (enforceEffectiveReadOnly) await assertNotEffectivelyWritable(expected.path);
    } catch {
      throw new Error("Documentation improvement npm runtime changed during validation.");
    }
  }
}

async function stableFileSha256(
  path: string,
  before: { dev: number; ino: number; uid: number; gid: number; mode: number; size: number },
): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  const after = await stat(path);
  if (
    !after.isFile() ||
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.uid !== before.uid ||
    after.gid !== before.gid ||
    after.mode !== before.mode ||
    after.size !== before.size
  ) {
    throw new Error("Documentation improvement npm runtime changed while hashing.");
  }
  return hash.digest("hex");
}

export async function validationNpmRuntimeTreeDigest(
  root: string,
  requiredOwner = 0,
  enforceEffectiveReadOnly = true,
  assertReadOnly: (path: string) => Promise<void> = assertNotEffectivelyWritable,
): Promise<string> {
  const canonicalRoot = await realpath(root);
  const hash = createHash("sha256");
  let entryCount = 0;
  let totalBytes = 0;
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      entryCount += 1;
      if (entryCount > MAX_NPM_RUNTIME_ENTRIES) {
        throw new Error("Documentation improvement npm runtime is too large.");
      }
      const path = join(directory, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const before = await lstat(path);
      if (
        (!before.isSymbolicLink() && (before.mode & 0o022) !== 0) ||
        before.uid !== requiredOwner
      ) {
        throw new Error("Documentation improvement npm runtime has unsafe ownership or mode.");
      }
      if (enforceEffectiveReadOnly) await assertReadOnly(path);
      if (before.isDirectory()) {
        hash.update(
          `${JSON.stringify([relativePath, "directory", before.uid, before.gid, before.mode])}\n`,
        );
        await visit(path, relativePath);
      } else if (before.isFile()) {
        totalBytes += before.size;
        if (totalBytes > MAX_NPM_RUNTIME_BYTES) {
          throw new Error("Documentation improvement npm runtime is too large.");
        }
        const contentSha256 = await stableFileSha256(path, before);
        hash.update(
          `${JSON.stringify([
            relativePath,
            "file",
            before.uid,
            before.gid,
            before.mode,
            before.size,
            contentSha256,
          ])}\n`,
        );
      } else if (before.isSymbolicLink()) {
        const target = await readlink(path);
        if (Buffer.byteLength(target) > 4096) {
          throw new Error("Documentation improvement npm runtime has an unsafe symbolic link.");
        }
        const resolved = await realpath(path);
        const withinRoot = relative(canonicalRoot, resolved);
        if (withinRoot === "" || withinRoot.startsWith("..") || isAbsolute(withinRoot)) {
          throw new Error(
            "Documentation improvement npm runtime symbolic link escapes its package.",
          );
        }
        const after = await lstat(path);
        if (
          !after.isSymbolicLink() ||
          !sameStat(before, after) ||
          (await readlink(path)) !== target
        ) {
          throw new Error("Documentation improvement npm runtime link changed while hashing.");
        }
        hash.update(
          `${JSON.stringify([
            relativePath,
            "symlink",
            before.uid,
            before.gid,
            before.mode,
            target,
          ])}\n`,
        );
      } else {
        throw new Error("Documentation improvement npm runtime has an unsafe entry type.");
      }
    }
  };
  await visit(canonicalRoot, "");
  return hash.digest("hex");
}

export async function assertNotEffectivelyWritable(path: string): Promise<void> {
  try {
    await access(path, constants.W_OK);
  } catch (error) {
    if (isPermissionDenied(error)) return;
    throw new Error("Documentation improvement npm runtime could not be checked for write access.");
  }
  throw new Error("Documentation improvement npm runtime is effectively writable.");
}

function isPermissionDenied(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ((error as { code?: unknown }).code === "EACCES" ||
      (error as { code?: unknown }).code === "EPERM")
  );
}

async function findExecutableOnPath(name: string): Promise<string> {
  for (const entry of (process.env.PATH ?? "").split(delimiter)) {
    if (!entry || !isAbsolute(entry)) continue;
    const candidate = join(entry, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next absolute PATH entry.
    }
  }
  throw new Error("Documentation improvement npm runtime is unavailable.");
}

export function sameStat(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean {
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
