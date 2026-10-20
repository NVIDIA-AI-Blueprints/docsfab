// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Shared first-pass scan exclusions and the unbound source-file allowlist, used
 * by the repository walks in gather and evidence acquisition. They decide what
 * the scan ranks without a name; a path the request or a `--source` selection
 * names is read wherever it sits, apart from host state.
 */
// The text and source formats evidence acquisition ranks without a name in the
// request: documentation, configuration, schemas, diffs, and source code. The
// markup entries mirror the host's source-extractor allowlist (`htm`, `html`,
// `xhtml`) so a scan and an explicit `--source` selection agree. This set
// decides what the scan offers unnamed; a path the request names is read
// whatever its extension. Every offered path still passes the regular-file,
// symlink, byte, and configured-credential checks.
export const SOURCE_EXTENSIONS = new Set([
  // Documentation and plain text.
  ".md",
  ".mdx",
  ".rst",
  ".adoc",
  ".asciidoc",
  ".txt",
  ".htm",
  ".html",
  ".xhtml",
  // Configuration, data schemas, and interface definitions.
  ".json",
  ".jsonc",
  ".toml",
  ".yaml",
  ".yml",
  ".ini",
  ".cfg",
  ".conf",
  ".properties",
  ".xml",
  ".proto",
  ".graphql",
  ".gql",
  ".sql",
  ".tf",
  ".hcl",
  ".cue",
  ".nix",
  // Changes.
  ".diff",
  ".patch",
  // Source code and build scripts.
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".vue",
  ".svelte",
  ".py",
  ".pyi",
  ".rs",
  ".go",
  ".java",
  ".kt",
  ".kts",
  ".scala",
  ".groovy",
  ".gradle",
  ".c",
  ".h",
  ".cc",
  ".cpp",
  ".cxx",
  ".hh",
  ".hpp",
  ".hxx",
  ".cu",
  ".cuh",
  ".m",
  ".mm",
  ".swift",
  ".cs",
  ".fs",
  ".rb",
  ".php",
  ".pl",
  ".pm",
  ".lua",
  ".r",
  ".jl",
  ".dart",
  ".ex",
  ".exs",
  ".erl",
  ".hs",
  ".ml",
  ".clj",
  ".zig",
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".ps1",
  ".cmake",
  ".bzl",
  ".bazel",
  ".mk",
  ".dockerfile",
]);

/** Extensionless build and container files that carry implementation facts. */
const SOURCE_FILE_NAMES = new Set([
  "dockerfile",
  "containerfile",
  "makefile",
  "gnumakefile",
  "jenkinsfile",
  "build",
  "workspace",
  "gemfile",
  "rakefile",
  "procfile",
]);

/**
 * Generated dependency locks: large, and they restate a manifest the scan
 * already offers. A request can still name one by path.
 */
const GENERATED_LOCK_NAMES = new Set(["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml"]);

/**
 * Whether evidence acquisition ranks this repository path without a name in
 * the request: a README, or a text or source format in SOURCE_EXTENSIONS.
 */
export function isUnnamedScanCandidate(path) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const folded = name.toLowerCase();
  if (/^readme(?:\.|$)/iu.test(name) || SOURCE_FILE_NAMES.has(folded)) return true;
  if (GENERATED_LOCK_NAMES.has(folded)) return false;
  const dot = folded.lastIndexOf(".");
  return dot > 0 && SOURCE_EXTENSIONS.has(folded.slice(dot));
}

/**
 * Directory names excluded at any depth: host state and third-party bytes.
 * `dist`, `build`, and `coverage` are here, not root-anchored, because monorepo
 * build output lives at `packages/<name>/dist`.
 */
export const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".docsfab",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".venv",
  "vendor",
]);

/**
 * Generated-site output directories, excluded only at the repository root:
 * `docs/public/` and `docs/site/` are often authored documentation, and
 * excluding them at any depth would make their pages unselectable.
 */
export const IGNORED_ROOT_DIRECTORIES = new Set(["out", "site", "_site", "public"]);

/**
 * The predicate both repository walks use. Names are compared case-folded,
 * matching a case-insensitive filesystem that treats `Site/` and `site/` as one.
 */
export function isIgnoredScanDirectory(name, atRepositoryRoot) {
  const folded = name.toLowerCase();
  return (
    IGNORED_DIRECTORIES.has(folded) ||
    (atRepositoryRoot === true && IGNORED_ROOT_DIRECTORIES.has(folded))
  );
}

/**
 * The excluded ancestor of a repository-relative path, or `undefined`. The
 * file's own name is not checked, so a page called `site` is not excluded.
 */
export function ignoredScanAncestor(path) {
  const segments = path.split("/").slice(0, -1);
  for (const [index, segment] of segments.entries()) {
    if (isIgnoredScanDirectory(segment, index === 0)) return segment;
  }
  return undefined;
}

/**
 * Host state, never repository evidence: a path under one of these is not
 * read even when the request or a `--source` selection names it.
 */
const HOST_STATE_DIRECTORIES = new Set([".git", ".docsfab"]);

/**
 * The host-state ancestor of a repository-relative path, or `undefined`.
 * Every other directory exclusion applies only to the ranked scan: a path
 * the operator names is read wherever it sits.
 */
export function hostStateAncestor(path) {
  return path
    .split("/")
    .slice(0, -1)
    .find((segment) => HOST_STATE_DIRECTORIES.has(segment.toLowerCase()));
}

/**
 * Whether the evidence scan ranks a tracked file without a name: not when it
 * sits under an ignored or a dot-prefixed directory, as the directory walk
 * never descends into either. A dot-prefixed file outside such a directory is
 * listed. A path the request names is read either way.
 */
export function isScanExcludedPath(path) {
  if (ignoredScanAncestor(path) !== undefined) return true;
  return path
    .split("/")
    .slice(0, -1)
    .some((segment) => segment.startsWith("."));
}
