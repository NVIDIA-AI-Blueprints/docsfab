// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type Stats } from "node:fs";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { assertDocsFabConfigurationRootPrivate } from "../config/host-paths.js";
import {
  SHA256,
  type ConfigurationRootSnapshot,
  type DirectoryPin,
  type DocsFabPrivateRoots,
  type StoragePins,
} from "./types.js";
import {
  currentUid,
  fileIdentity,
  isAlreadyExists,
  isNotFound,
  normalizedAbsolute,
  pathsOverlap,
  sameDirectoryIdentity,
} from "./shared.js";

export async function allocatePinnedPrivateRoots(
  roots: DocsFabPrivateRoots,
  repositoryPath?: string,
  configRoot?: string,
): Promise<StoragePins> {
  const layout = privateLayout(roots);
  if (repositoryPath && configRoot) assertStorageDisjoint(repositoryPath, configRoot, roots);
  const authorityPins = await ensureCanonicalDirectoryChain(layout.authorityRoot);
  const authority = authorityPins.at(-1)!;
  const docsfab = await ensurePrivateChild(authority, layout.docsfabRoot);
  const projects = await ensurePrivateChild(docsfab, layout.projectsRoot);
  const project = await ensurePrivateChild(projects, layout.projectRoot);
  const pins = [...authorityPins, docsfab, projects, project];
  for (const path of [roots.runs, roots.evidence, roots.delivery, roots.receipts]) {
    pins.push(await ensurePrivateChild(project, path));
  }
  await verifyPins(pins);
  for (const path of [layout.docsfabRoot, ...Object.values(roots)]) {
    if ((await realpath(path)) !== path)
      throw new Error("DocsFab private storage must use canonical paths.");
  }
  return {
    pins,
    projectRoot: project,
    lockPath: resolve(layout.projectRoot, "init.lock"),
    journalPath: resolve(layout.projectRoot, "init-journal.json"),
    journalAnchorPath: resolve(layout.projectRoot, "init-journal.anchor"),
    receiptPath: resolve(layout.projectRoot, "init-receipt.json"),
  };
}

export function privateLayout(roots: DocsFabPrivateRoots): {
  authorityRoot: string;
  docsfabRoot: string;
  projectsRoot: string;
  projectRoot: string;
} {
  const paths = Object.values(roots);
  if (
    new Set(paths).size !== 4 ||
    basename(roots.runs) !== "runs" ||
    basename(roots.evidence) !== "evidence" ||
    basename(roots.delivery) !== "delivery" ||
    basename(roots.receipts) !== "receipts"
  ) {
    throw new Error("DocsFab private roots have an invalid layout.");
  }
  const projectRoot = dirname(roots.runs);
  if (
    paths.some(
      (path) => !isAbsolute(path) || resolve(path) !== path || dirname(path) !== projectRoot,
    )
  ) {
    throw new Error("DocsFab private roots must be normalized absolute siblings.");
  }
  const projectsRoot = dirname(projectRoot);
  const docsfabRoot = dirname(projectsRoot);
  if (basename(projectsRoot) !== "projects" || !SHA256.test(basename(projectRoot))) {
    throw new Error("DocsFab private roots have an invalid project layout.");
  }
  return { authorityRoot: dirname(docsfabRoot), docsfabRoot, projectsRoot, projectRoot };
}

export function assertStorageDisjoint(
  repositoryPath: string,
  configRoot: string,
  roots: DocsFabPrivateRoots,
): void {
  const { docsfabRoot } = privateLayout(roots);
  const repository = normalizedAbsolute(repositoryPath, "repository path");
  const configuration = normalizedAbsolute(configRoot, "configuration root");
  if (pathsOverlap(docsfabRoot, repository) || pathsOverlap(docsfabRoot, configuration)) {
    throw new Error(
      "DocsFab private storage must be disjoint from the repository and configuration root.",
    );
  }
}

/**
 * Public refusal codes init raises for the configuration root. The literal is
 * duplicated into `operator/failure-classification.ts` (which must not import
 * this module); `failure-classification.test.ts` enumerates this tuple.
 */
export const INIT_CONFIGURATION_ROOT_REFUSAL_CODES = [
  "configuration-root-not-canonical",
  "configuration-root-not-private",
] as const;

/**
 * The configuration root was named through a symlink or another alias of its
 * canonical path. The guard stays (a symlinked root is a TOCTOU hazard between
 * preview and commit); the refusal names the canonical path to use instead.
 * `code` is never `ENOENT`, so the missing-root walk never absorbs it.
 */
export class ConfigurationRootNotCanonicalError extends Error {
  readonly code = INIT_CONFIGURATION_ROOT_REFUSAL_CODES[0];
  readonly canonicalPath: string;

  constructor(canonicalPath: string, displayPath: string) {
    super(
      `DocsFab configuration root must use one canonical path; it resolves to "${displayPath}". Rerun init with DOCSFAB_CONFIG_ROOT set to that resolved path.`,
    );
    this.name = "ConfigurationRootNotCanonicalError";
    this.canonicalPath = canonicalPath;
  }
}

/**
 * The canonical root as the operator should type it. Operator output redacts
 * host paths under `/Users/`, `/home/`, and `/root/`, so a root inside HOME is
 * shown as `~/...`. That form is used only when HOME is itself canonical and
 * contains the root; any other HOME (symlinked, non-normalized, unreadable)
 * would expand `~/` back into a path init refuses, so the absolute path is kept.
 */
export async function configurationRootDisplayPath(
  canonicalPath: string,
  homeDirectory: string,
): Promise<string> {
  const canonicalHome = await realpath(homeDirectory).catch(() => undefined);
  if (canonicalHome === undefined || canonicalHome !== homeDirectory) return canonicalPath;
  const inside = relative(homeDirectory, canonicalPath);
  if (inside === "") return "~";
  if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return canonicalPath;
  return `~/${inside}`;
}

async function notCanonicalRoot(
  canonicalPath: string,
  homeDirectory: string,
): Promise<ConfigurationRootNotCanonicalError> {
  return new ConfigurationRootNotCanonicalError(
    canonicalPath,
    await configurationRootDisplayPath(canonicalPath, homeDirectory),
  );
}

export async function captureConfigurationRoot(
  path: string,
  homeDirectory: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ConfigurationRootSnapshot> {
  const normalized = normalizedAbsolute(path, "configuration root");
  try {
    const canonical = await realpath(normalized);
    if (canonical !== normalized) {
      throw await notCanonicalRoot(canonical, homeDirectory);
    }
    assertDocsFabConfigurationRootPrivate(canonical, environment);
    const final = await captureTrustedDirectoryPin(canonical);
    return { path: canonical, exists: true, pins: await prependOwnedAncestors(final) };
  } catch (error) {
    if (isNotFound(error)) {
      const missing = await captureMissingConfigurationAuthority(normalized, homeDirectory);
      return { path: normalized, exists: false, pins: missing };
    }
    throw error;
  }
}

export async function verifyConfigurationRoot(snapshot: ConfigurationRootSnapshot): Promise<void> {
  await verifyPins(snapshot.pins);
  if (snapshot.exists) {
    if ((await realpath(snapshot.path)) !== snapshot.path) {
      throw new Error("DocsFab configuration root changed before commit.");
    }
    return;
  }
  try {
    await lstat(snapshot.path);
  } catch (error) {
    if (isNotFound(error)) return;
    throw new Error("DocsFab configuration root could not be revalidated.");
  }
  throw new Error("DocsFab configuration root appeared after preview.");
}

export async function captureMissingConfigurationAuthority(
  path: string,
  homeDirectory: string,
): Promise<DirectoryPin[]> {
  const suffix: string[] = [];
  let cursor = path;
  while (true) {
    try {
      const canonical = await realpath(cursor);
      const effective = resolve(canonical, ...suffix.reverse());
      if (effective !== path) throw await notCanonicalRoot(effective, homeDirectory);
      const final = await captureTrustedDirectoryPin(canonical);
      return prependOwnedAncestors(final);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      const parent = dirname(cursor);
      if (parent === cursor)
        throw new Error("DocsFab configuration root has no safe existing ancestor.");
      suffix.push(basename(cursor));
      cursor = parent;
    }
  }
}

export async function ensureCanonicalDirectoryChain(path: string): Promise<DirectoryPin[]> {
  const missing: string[] = [];
  let cursor = path;
  while (true) {
    try {
      const existing = await captureDirectoryPin(cursor, false);
      if ((await realpath(cursor)) !== cursor)
        throw new Error("DocsFab private storage must use canonical paths.");
      const pins: DirectoryPin[] = [existing];
      let ancestorPath = dirname(cursor);
      while (ancestorPath !== cursor) {
        const ancestor = await captureOwnedCanonicalAncestor(ancestorPath);
        if (!ancestor) break;
        pins.unshift(ancestor);
        cursor = ancestorPath;
        ancestorPath = dirname(ancestorPath);
      }
      let parent = existing;
      for (const child of missing.reverse()) {
        parent = await ensurePrivateChild(parent, child);
        pins.push(parent);
      }
      return pins;
    } catch (error) {
      if (!isNotFound(error)) throw error;
      missing.push(cursor);
      const parent = dirname(cursor);
      if (parent === cursor)
        throw new Error("No safe existing ancestor was found for DocsFab private storage.");
      cursor = parent;
    }
  }
}

export async function captureOwnedCanonicalAncestor(
  path: string,
): Promise<DirectoryPin | undefined> {
  try {
    const metadata = await lstat(path);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      metadata.uid !== currentUid() ||
      (await realpath(path)) !== path
    )
      return undefined;
    return { path, identity: fileIdentity(metadata), private: false };
  } catch {
    return undefined;
  }
}

export async function captureOwnedDirectoryChain(path: string): Promise<DirectoryPin[]> {
  const final = await captureDirectoryPin(path, false);
  if ((await realpath(path)) !== path)
    throw new Error("An initialization authority path is not canonical.");
  return prependOwnedAncestors(final);
}

export async function prependOwnedAncestors(final: DirectoryPin): Promise<DirectoryPin[]> {
  const pins = [final];
  let child = final.path;
  let ancestorPath = dirname(child);
  while (ancestorPath !== child) {
    const ancestor = await captureOwnedCanonicalAncestor(ancestorPath);
    if (!ancestor) break;
    pins.unshift(ancestor);
    child = ancestorPath;
    ancestorPath = dirname(ancestorPath);
  }
  return pins;
}

export async function ensurePrivateChild(
  parent: DirectoryPin,
  path: string,
): Promise<DirectoryPin> {
  if (dirname(path) !== parent.path)
    throw new Error("DocsFab private directory creation escaped its pinned parent.");
  await verifyPin(parent);
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!isAlreadyExists(error))
      throw new Error("Could not allocate owner-private DocsFab storage.");
  }
  await verifyPin(parent);
  const child = await captureDirectoryPin(path, true);
  if ((await realpath(path)) !== path)
    throw new Error("DocsFab private storage must use canonical paths.");
  return child;
}

export async function captureDirectoryPin(
  path: string,
  privateDirectory: boolean,
): Promise<DirectoryPin> {
  let metadata: Stats;
  try {
    metadata = await lstat(path);
  } catch (error) {
    throw error;
  }
  const identity = fileIdentity(metadata);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    identity.uid !== currentUid() ||
    (privateDirectory && (identity.mode & 0o077) !== 0)
  ) {
    throw new Error(
      privateDirectory
        ? "DocsFab private storage must be an owner-controlled, mode-0700 directory."
        : "The repository or storage authority directory is not owner controlled.",
    );
  }
  return { path, identity, private: privateDirectory };
}

export async function captureTrustedDirectoryPin(path: string): Promise<DirectoryPin> {
  const metadata = await lstat(path);
  const identity = fileIdentity(metadata);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (identity.mode & 0o022) !== 0) {
    throw new Error("DocsFab configuration root is not a trusted canonical directory.");
  }
  return { path, identity, private: false };
}

export async function verifyPins(pins: readonly DirectoryPin[]): Promise<void> {
  for (const pin of pins) await verifyPin(pin);
}

export async function verifyPin(pin: DirectoryPin): Promise<void> {
  let metadata: Stats;
  try {
    metadata = await lstat(pin.path);
  } catch {
    throw new Error("A pinned initialization directory became unavailable.");
  }
  const current = fileIdentity(metadata);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    !sameDirectoryIdentity(current, pin.identity) ||
    (pin.private && (current.mode & 0o077) !== 0)
  ) {
    throw new Error("A pinned initialization directory changed before commit.");
  }
}
