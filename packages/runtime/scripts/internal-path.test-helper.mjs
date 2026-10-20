// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Skip conditions and the export's excluded paths for tests under packages/runtime/scripts. */
import { statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

// The export drops the GitLab pipeline definition, so only a tree without it
// may skip. In the internal repository every declared path is read as before,
// and a missing one fails its test instead of hiding behind a skip.
const EXPORTED_TREE_MARKER = ".gitlab-ci.yml";

/**
 * The files `loadExportExcluded` reads: the export manifest and its parser.
 * Runtime tests depend on both, so the runtime CI rules trigger on each;
 * `.gitlab/ci/generate-runtime-derived-ci.mjs` renders this list into them.
 */
export const EXPORT_MANIFEST_INPUTS = Object.freeze([
  "scripts/public-export/manifest.yaml",
  "scripts/public-export/check-boundary.mjs",
]);

/**
 * The public export manifest's `exclude` list, in its order, read from the
 * manifest under `root`. The manifest is itself excluded, so an exported tree
 * lacks it; that tree is already the export's result and holds nothing left
 * to exclude, so the list is empty there. In the internal tree a missing or
 * invalid manifest throws.
 */
export async function loadExportExcluded(root = repositoryRoot) {
  const [manifestPath, parserPath] = EXPORT_MANIFEST_INPUTS;
  if (isAbsent(root, EXPORTED_TREE_MARKER) && isAbsent(root, manifestPath)) {
    return Object.freeze([]);
  }
  const { loadManifest } = await import(pathToFileURL(resolve(repositoryRoot, parserPath)).href);
  return Object.freeze([...loadManifest(resolve(root, manifestPath)).exclude]);
}

/** The export's excluded paths for this checkout; see `loadExportExcluded`. `*` matches within one path segment. */
export const EXPORT_EXCLUDED = await loadExportExcluded();

function segmentMatches(pattern, segment) {
  if (!pattern.includes("*")) return pattern === segment;
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, "\\$&"))
    .join("[^/]*");
  return new RegExp(`^${source}$`, "u").test(segment);
}

/** True when repository-relative `path` is an excluded entry or lies beneath one. */
export function isExportExcluded(path, excluded = EXPORT_EXCLUDED) {
  const segments = path.split("/");
  return excluded.some((entry) => {
    const patterns = entry.split("/");
    return (
      segments.length >= patterns.length &&
      patterns.every((pattern, index) => segmentMatches(pattern, segments[index]))
    );
  });
}

/** True when an excluded entry lies strictly beneath repository-relative directory `path`. */
export function holdsExportExcluded(path, excluded = EXPORT_EXCLUDED) {
  const segments = path.split("/");
  return excluded.some((entry) => {
    const patterns = entry.split("/");
    return (
      patterns.length > segments.length &&
      segments.every((segment, index) => segmentMatches(patterns[index], segment))
    );
  });
}

/**
 * Test options for a case that reads repository paths the public export
 * leaves out: `{ skip: <reason> }` only in an exported tree that lacks one of
 * `paths`, otherwise `{ skip: false }`. Spread it into the case's options.
 */
export function internalOnly(paths, reason, root = repositoryRoot) {
  const declared = typeof paths === "string" ? [paths] : [...paths];
  if (declared.length === 0 || typeof reason !== "string" || reason.trim() === "") {
    throw new Error("internalOnly needs at least one repository path and a reason.");
  }
  for (const path of declared) {
    if (path === "" || isAbsolute(path) || path.split("/").includes("..")) {
      throw new Error(`internalOnly path must be repository-relative: ${JSON.stringify(path)}.`);
    }
  }
  const missing = isAbsent(root, EXPORTED_TREE_MARKER)
    ? declared.filter((path) => isAbsent(root, path))
    : [];
  return Object.freeze({
    skip:
      missing.length === 0
        ? false
        : `internal-only, skipped: ${missing.join(", ")} absent from the exported tree; ${reason}`,
  });
}

function isAbsent(root, path) {
  try {
    statSync(resolve(root, path));
    return false;
  } catch (error) {
    // Only a missing entry means the export left the path out. Anything else,
    // such as a file where a directory belongs or a denied read, is a broken
    // tree and must fail loudly.
    if (error?.code === "ENOENT") return true;
    throw error;
  }
}
