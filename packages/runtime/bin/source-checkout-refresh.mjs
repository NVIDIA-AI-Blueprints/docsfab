// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const SKIP_AUTO_BUILD_ENV = "DOCSFAB_SKIP_AUTO_BUILD";

const SOURCE_LAUNCHER = join("src", "launcher.ts");
const BUILD_SCRIPT = join("scripts", "build-package.mjs");
const BUILD_IDENTITY_SCRIPT = join("scripts", "build-identity.mjs");
const DERIVED_STEP_SCRIPT = join("scripts", "ensure-derived.mjs");
const COMPILED_LAUNCHER = join("dist", "launcher.js");
const COMPILED_MANIFEST = join("dist", "workflow-registry", "manifest.js");
const WORKFLOW_DIRECTORY = "workflows";
const WORKFLOW_SCHEMA_FILENAME = "workflow.schema.json";
const SOURCE_WATCH_PATHS = [
  "src",
  "workflows",
  "tsconfig.json",
  "package.json",
  BUILD_SCRIPT,
  BUILD_IDENTITY_SCRIPT,
];
const RECURSIVE_INPUT_SUFFIX = "/**/*";
// Never read as an input: installs, build output, and Python bytecode caches,
// which running the quality checks writes and the quality-pack generator skips.
const UNWATCHED_DIRECTORY_NAMES = new Set(["node_modules", "dist", "__pycache__"]);

/**
 * True when this package root still contains checkout sources. Packed
 * registry installs omit `src/` and must never spawn a rebuild.
 *
 * @param {string} packageRoot
 * @returns {boolean}
 */
export function isSourceCheckout(packageRoot) {
  return (
    existsSync(join(packageRoot, SOURCE_LAUNCHER)) &&
    existsSync(join(packageRoot, BUILD_SCRIPT)) &&
    existsSync(join(packageRoot, WORKFLOW_DIRECTORY))
  );
}

/**
 * True when a source checkout should rebuild `dist/` before launching.
 *
 * @param {string} packageRoot
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<boolean>}
 */
export async function shouldRefreshCompiledLauncher(packageRoot, env = process.env) {
  if (env[SKIP_AUTO_BUILD_ENV] === "1") return false;
  return compiledLauncherIsStale(packageRoot);
}

/**
 * The paths whose changes rebuild `dist/`: the package's own sources plus the
 * canonical inputs of the derived products the build regenerates first. The
 * input list is loaded from this checkout's `scripts/` only after the caller
 * has established a source checkout, because packed installs omit `scripts/`.
 *
 * @param {string} packageRoot
 * @returns {Promise<string[]>} absolute paths, none inside another
 */
export async function compiledLauncherWatchPaths(packageRoot) {
  return watchPathsFor(packageRoot, await loadDerivedInputs(packageRoot));
}

/**
 * @param {string} packageRoot
 * @returns {Promise<readonly string[]>}
 */
async function loadDerivedInputs(packageRoot) {
  const { ENSURE_DERIVED_INPUTS } = await import(
    pathToFileURL(join(packageRoot, DERIVED_STEP_SCRIPT)).href
  );
  return ENSURE_DERIVED_INPUTS;
}

/**
 * @param {string} packageRoot
 * @param {readonly string[]} inputs
 * @returns {string[]}
 */
function watchPathsFor(packageRoot, inputs) {
  const repositoryRoot = resolve(packageRoot, "..", "..");
  const paths = [
    ...SOURCE_WATCH_PATHS.map((path) => join(packageRoot, path)),
    ...inputs.map((input) => {
      const path = input.endsWith(RECURSIVE_INPUT_SUFFIX)
        ? input.slice(0, -RECURSIVE_INPUT_SUFFIX.length)
        : input;
      // Any other glob shape would name a path that never exists and so is never read.
      if (path.includes("*")) {
        throw new Error(
          `${DERIVED_STEP_SCRIPT} declares the input ${JSON.stringify(input)}, which the source-checkout launcher cannot watch: it reads plain paths and directories written as <directory>${RECURSIVE_INPUT_SUFFIX}.`,
        );
      }
      return join(repositoryRoot, path);
    }),
  ];
  // An input under a source root, such as src/skills/catalog-ids.ts, is
  // already read with that root.
  return [...new Set(paths)].filter(
    (path) => !paths.some((other) => other !== path && isInside(path, other)),
  );
}

/**
 * Rebuild `dist/` when this checkout is a source tree and the compiled
 * launcher is missing, older than its sources or the derived-generation
 * inputs, or lists a different workflow catalog than `workflows/*.json`. The
 * build first regenerates stale derived files, so this also refreshes them.
 *
 * @param {string} packageRoot
 * @param {{
 *   env?: NodeJS.ProcessEnv;
 *   runBuild?: (packageRoot: string) => void;
 *   write?: (line: string) => void;
 * }} [options]
 * @returns {Promise<void>}
 */
export async function refreshCompiledLauncherIfStale(packageRoot, options = {}) {
  const env = options.env ?? process.env;
  const write = options.write ?? ((line) => process.stderr.write(`${line}\n`));
  if (env[SKIP_AUTO_BUILD_ENV] === "1") {
    // Handles exactly an opted-out checkout that is stale, or whose watch list
    // could not load: it launches the existing dist/ as is, and says which.
    const staleness = await compiledLauncherStaleness(packageRoot);
    if (staleness.inputLoadFailure !== undefined) {
      write(
        `DocsFab is launching the existing dist/ without checking whether it is current, because ${SKIP_AUTO_BUILD_ENV}=1 and ${DERIVED_STEP_SCRIPT} could not load the derived-generation inputs: ${staleness.inputLoadFailure}`,
      );
    } else if (staleness.stale) {
      write(
        `DocsFab is not rebuilding dist/ or regenerating derived files because ${SKIP_AUTO_BUILD_ENV}=1, although this checkout is newer than dist/.`,
      );
    }
    requireCompiledLauncher(packageRoot);
    return;
  }
  const staleness = await compiledLauncherStaleness(packageRoot);
  if (staleness.stale) {
    // A watch list that could not load counts as stale, so the build reports
    // the same failure through the rebuild refusal below.
    write(
      staleness.inputLoadFailure === undefined
        ? "DocsFab is rebuilding the compiled launcher, after regenerating any stale derived files, because this checkout is newer than dist/."
        : `DocsFab is rebuilding the compiled launcher, after regenerating any stale derived files, because ${DERIVED_STEP_SCRIPT} could not load the derived-generation inputs: ${staleness.inputLoadFailure}`,
    );
    write("");
    const runBuild = options.runBuild ?? ((root) => defaultRunBuild(root, write));
    runBuild(packageRoot);
  }
  requireCompiledLauncher(packageRoot);
}

/** @param {string} packageRoot */
function requireCompiledLauncher(packageRoot) {
  if (!existsSync(join(packageRoot, COMPILED_LAUNCHER))) {
    throw new Error(
      "DocsFab could not find dist/launcher.js. From the DocsFab repository root, run npm --prefix packages/runtime run build and retry.",
    );
  }
}

/**
 * @param {string} packageRoot
 * @returns {boolean}
 */
export function compiledWorkflowCatalogMismatchesDisk(packageRoot) {
  const manifestPath = join(packageRoot, COMPILED_MANIFEST);
  if (!existsSync(manifestPath)) return true;
  const expected = readCompiledWorkflowNames(readFileSync(manifestPath, "utf8"));
  if (expected === undefined) return true;
  const actual = listWorkflowNames(join(packageRoot, WORKFLOW_DIRECTORY));
  return JSON.stringify(expected) !== JSON.stringify(actual);
}

/**
 * @param {string} source
 * @returns {string[] | undefined}
 */
export function readCompiledWorkflowNames(source) {
  const match = /export const DECLARATIVE_WORKFLOW_NAMES = \[([\s\S]*?)\];/u.exec(source);
  if (!match) return undefined;
  return [...match[1].matchAll(/"([^"]+)"/gu)].map((entry) => entry[1]).sort();
}

/**
 * @param {string} packageRoot
 * @param {(line: string) => void} write
 */
function defaultRunBuild(packageRoot, write) {
  const result = spawnSync(process.execPath, [join(packageRoot, BUILD_SCRIPT)], {
    cwd: packageRoot,
    encoding: "utf8",
    env: { ...process.env, PI_OFFLINE: "1" },
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || `exit ${String(result.status)}`).trim();
    throw new Error(
      `DocsFab could not rebuild the compiled launcher, so dist/ is unchanged. If this checkout pulled new commits, run npm --prefix packages/runtime ci from the DocsFab repository root and retry.\n\n${detail}`,
    );
  }
  // A passing build can still report, such as the files its derived-generation
  // step rewrote; those lines reach the operator.
  for (const line of `${result.stdout ?? ""}${result.stderr ?? ""}`.split("\n")) {
    if (line.trim() !== "") write(line);
  }
}

/**
 * @param {string} packageRoot
 * @returns {Promise<boolean>}
 */
async function compiledLauncherIsStale(packageRoot) {
  return (await compiledLauncherStaleness(packageRoot)).stale;
}

/**
 * Whether `dist/` is stale. When the derived-generation inputs cannot load,
 * the answer is unknown, so it reads as stale with the load failure attached.
 *
 * @param {string} packageRoot
 * @returns {Promise<{ stale: boolean; inputLoadFailure?: string }>}
 */
async function compiledLauncherStaleness(packageRoot) {
  if (!isSourceCheckout(packageRoot)) return { stale: false };
  if (!existsSync(join(packageRoot, COMPILED_LAUNCHER))) return { stale: true };
  if (compiledWorkflowCatalogMismatchesDisk(packageRoot)) return { stale: true };
  let inputs;
  try {
    inputs = await loadDerivedInputs(packageRoot);
  } catch (error) {
    // Handles exactly the import of scripts/ensure-derived.mjs and its module
    // graph throwing, such as a malformed deploy-root config or a syntax
    // error in a generator mid-edit. Reading mtimes, the catalog and the build
    // stay outside this catch.
    return { stale: true, inputLoadFailure: firstLine(error) };
  }
  if (compiledLauncherIsOlderThan(packageRoot, watchPathsFor(packageRoot, inputs))) {
    return { stale: true };
  }
  const { readBuildIdentity } = await import(
    pathToFileURL(join(packageRoot, BUILD_IDENTITY_SCRIPT)).href
  );
  const repositoryRoot = resolve(packageRoot, "..", "..");
  const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  const current = await readBuildIdentity(repositoryRoot, { version: packageJson.version });
  if (current.commit === null) return { stale: false };
  const stamped = readCompiledBuildIdentity(packageRoot);
  const stampedReleaseTag = readCompiledReleaseTag(packageRoot);
  return {
    stale:
      stamped?.commit !== current.commit ||
      stamped?.dirty !== current.dirty ||
      stampedReleaseTag !== current.releaseTag,
  };
}

/** @param {string} packageRoot */
function readCompiledBuildIdentity(packageRoot) {
  const path = join(packageRoot, "dist", "build-identity.js");
  if (!existsSync(path)) return null;
  const match = /DOCSFAB_BUILD_IDENTITY = Object\.freeze\((\{[\s\S]*?\})\);/u.exec(
    readFileSync(path, "utf8"),
  );
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

/** @param {string} packageRoot */
function readCompiledReleaseTag(packageRoot) {
  const path = join(packageRoot, "dist", "release-identity.js");
  if (!existsSync(path)) return null;
  const match = /DOCSFAB_RELEASE_IDENTITY = Object\.freeze\((\{[\s\S]*?\})\);/u.exec(
    readFileSync(path, "utf8"),
  );
  if (!match) return null;
  try {
    return JSON.parse(match[1]).releaseTag ?? null;
  } catch {
    return null;
  }
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function firstLine(error) {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.split("\n")[0];
}

/**
 * @param {string} path
 * @param {string} directory
 * @returns {boolean}
 */
function isInside(path, directory) {
  const offset = relative(directory, path);
  return offset !== "" && offset !== ".." && !offset.startsWith(`..${sep}`) && !isAbsolute(offset);
}

/**
 * @param {string} directory
 * @returns {string[]}
 */
function listWorkflowNames(directory) {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json") && name !== WORKFLOW_SCHEMA_FILENAME)
    .map((name) => name.slice(0, -".json".length))
    .sort();
}

/**
 * @param {string} packageRoot
 * @param {readonly string[]} watchPaths
 * @returns {boolean}
 */
function compiledLauncherIsOlderThan(packageRoot, watchPaths) {
  const compiledTime = statSync(join(packageRoot, COMPILED_LAUNCHER)).mtimeMs;
  return watchPaths.some((path) => existsSync(path) && newestMtime(path) > compiledTime);
}

/**
 * @param {string} path
 * @returns {number}
 */
function newestMtime(path) {
  const stats = statSync(path);
  if (stats.isFile()) return stats.mtimeMs;
  if (!stats.isDirectory()) return stats.mtimeMs;
  let newest = stats.mtimeMs;
  for (const name of readdirSync(path)) {
    if (UNWATCHED_DIRECTORY_NAMES.has(name)) continue;
    newest = Math.max(newest, newestMtime(join(path, name)));
  }
  return newest;
}
