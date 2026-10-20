// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The repository's GitLab CI configuration as GitLab assembles it: each
 * `include: - local:` file of `.gitlab-ci.yml` in order, then `.gitlab-ci.yml`
 * itself, merged by top-level key. Template, component, and remote includes are
 * not loaded, so their jobs and hidden keys are absent.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";

const ROOT_CONFIG = ".gitlab-ci.yml";
// Top-level keys GitLab reads as global configuration rather than as a job.
const GLOBAL_KEYWORDS = new Set([
  "default",
  "include",
  "stages",
  "variables",
  "workflow",
  "image",
  "services",
  "cache",
  "before_script",
  "after_script",
]);

export type GitlabCiConfig = {
  /** Top-level keys from every loaded file, merged in load order. */
  definitions: Record<string, unknown>;
  /** Top-level keys each loaded file declares, by repository-relative path. */
  keysByFile: ReadonlyMap<string, readonly string[]>;
};

function isHash(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** GitLab include merging: hashes merge recursively, later files win, arrays and scalars replace. */
function deepMerge(base: unknown, overlay: unknown): unknown {
  if (!isHash(base) || !isHash(overlay)) return overlay;
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    merged[key] = Object.hasOwn(merged, key) ? deepMerge(merged[key], value) : value;
  }
  return merged;
}

function localIncludes(root: Record<string, unknown>): string[] {
  const include = root.include;
  const entries = include === undefined ? [] : Array.isArray(include) ? include : [include];
  const paths: string[] = [];
  for (const entry of entries) {
    if (typeof entry === "string") {
      // A bare string is a local include unless it is a URL.
      if (!/^https?:\/\//u.test(entry)) paths.push(entry);
    } else if (isHash(entry) && typeof entry.local === "string") {
      paths.push(entry.local);
    }
  }
  return paths.map((path) => path.replace(/^\//u, ""));
}

async function readYamlHash(
  repositoryRoot: string,
  path: string,
): Promise<Record<string, unknown>> {
  const parsed: unknown = parse(await readFile(join(repositoryRoot, path), "utf8"));
  if (parsed === null || parsed === undefined) return {};
  if (!isHash(parsed)) throw new Error(`${path} is not a YAML mapping`);
  return parsed;
}

export async function readGitlabCiConfig(repositoryRoot: string): Promise<GitlabCiConfig> {
  const root = await readYamlHash(repositoryRoot, ROOT_CONFIG);
  const keysByFile = new Map<string, readonly string[]>();
  let definitions: Record<string, unknown> = {};
  for (const path of [...localIncludes(root), ROOT_CONFIG]) {
    if (keysByFile.has(path)) throw new Error(`${path} is included more than once`);
    const source = path === ROOT_CONFIG ? root : await readYamlHash(repositoryRoot, path);
    keysByFile.set(path, Object.keys(source));
    definitions = deepMerge(definitions, source) as Record<string, unknown>;
  }
  return { definitions, keysByFile };
}

/** Top-level keys one loaded file declares; refuses a path `.gitlab-ci.yml` does not include. */
export function keysDeclaredIn(config: GitlabCiConfig, path: string): readonly string[] {
  const keys = config.keysByFile.get(path);
  if (!keys) throw new Error(`${path} is not a local include of ${ROOT_CONFIG}`);
  return keys;
}

/** Every job the loaded files declare or overlay: top-level keys that are neither hidden nor global keywords. */
export function jobNames(config: GitlabCiConfig): string[] {
  return Object.keys(config.definitions).filter(
    (name) => !name.startsWith(".") && !GLOBAL_KEYWORDS.has(name),
  );
}

/**
 * A `rules:changes` glob, matched the way GitLab's fnmatch does with
 * FNM_PATHNAME and FNM_DOTMATCH: `*` stays within one path segment, and a `**`
 * segment spans zero or more directories. Other glob syntax throws, so an
 * unmodelled pattern cannot silently never match.
 */
function ciPathPattern(pattern: string): RegExp {
  if (/[?[\]{}\\]/u.test(pattern)) throw new Error(`Unsupported rules:changes pattern: ${pattern}`);
  let source = "";
  for (let index = 0; index < pattern.length; ) {
    const character = pattern.charAt(index);
    if (pattern.startsWith("**/", index)) {
      source += "(?:.*/)?";
      index += 3;
    } else if (character === "*") {
      source += "[^/]*";
      index += 1;
    } else {
      source += character.replace(/[.+^$()|]/u, "\\$&");
      index += 1;
    }
  }
  return new RegExp(`^${source}$`, "u");
}

export function matchesCiPath(path: string, pattern: string): boolean {
  return ciPathPattern(pattern).test(path);
}
