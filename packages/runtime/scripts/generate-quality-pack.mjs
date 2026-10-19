#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Stage the quality-owned Pin C assets into the self-contained runtime and
 * bind their exact lock to the generated Pin B catalog-skill lock.
 *
 * Usage:
 *   node scripts/generate-quality-pack.mjs
 *   node scripts/generate-quality-pack.mjs --check
 */
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HISTORICAL_QUALITY_PROGRAM } from "../src/quality-pack/resource-roles.js";

import {
  QUALITY_RUNTIME_POLICY_ROOT,
  QUALITY_SOURCE_ROOT,
  QUALITY_SOURCE_ROOTS,
} from "./derived-products.mjs";

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(runtimeRoot, "../..");
const sourceRoot = resolve(repoRoot, QUALITY_SOURCE_ROOT);
const qualityRoot = resolve(runtimeRoot, "quality");
const packRoot = resolve(runtimeRoot, "quality-pack");
const qualityLockPath = resolve(qualityRoot, "lock.json");
const packManifestPath = resolve(packRoot, "manifest.json");
const skillLockPath = resolve(runtimeRoot, "skill-crate/lock.json");
// The public repository: the internal and exported trees stamp the same
// identity, and each revision is a content digest rather than a commit.
const SOURCE_REPO = "https://github.com/NVIDIA-AI-Blueprints/docsfab.git";
const SOURCE_ROOTS = QUALITY_SOURCE_ROOTS;
// Qualification requires a scorer-private corpus, governed source inputs, and
// an external freeze authority that are not part of the installable runtime
// quality pack. Keep the source-checkout scorer out of the staged payload until
// a separately locked, relocatable qualification kit exists.
export const SOURCE_ONLY_FILES = new Set([
  "checks/score_harness_role_qualification.py",
  "checks/package_inputs.py",
  "checks/run_tests.py",
  "checks/smoke_public.py",
]);
// Source validation has distribution-specific inputs. Its existing installed
// resource stays a separate canonical policy input so source tooling does not
// invalidate an otherwise unchanged evaluator or saved-checkpoint binding.
export const RUNTIME_POLICY_FILES = Object.freeze({
  [HISTORICAL_QUALITY_PROGRAM.qualityPath]: HISTORICAL_QUALITY_PROGRAM.qualitySourcePath,
});
if (!HISTORICAL_QUALITY_PROGRAM.qualitySourcePath.startsWith(`${QUALITY_RUNTIME_POLICY_ROOT}/`)) {
  throw new Error(
    "Historical quality source must remain under its declared runtime policy input root.",
  );
}
function sourcePath(root, path) {
  return resolve(root, RUNTIME_POLICY_FILES[path] ?? path);
}
// The product-default resource declaration. It names the bound style and
// evaluation profiles, so a run binds what this file says, not a source constant.
export const PRODUCT_DEFAULT_DECLARATION_PATH = "profiles/product-default.json";

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function bundleSha256(files) {
  return sha256(files.map((file) => `${file.sha256}  ${file.path}\n`).join(""));
}

async function listFiles(directory, prefix = "") {
  const entries = await readdir(join(directory, prefix), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "__pycache__") continue;
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await listFiles(directory, path)));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

async function sourceFiles(root) {
  return (
    await Promise.all(
      SOURCE_ROOTS.map(async (subtree) =>
        Promise.all(
          (
            await listFiles(root, subtree)
          )
            .filter((path) => !SOURCE_ONLY_FILES.has(path))
            .map(async (path) => ({
              path,
              sha256: sha256(await readFile(sourcePath(root, path))),
            })),
        ),
      ),
    )
  )
    .flat()
    .sort((left, right) => left.path.localeCompare(right.path));
}

function parseYamlId(contents, path) {
  const match = /^id:\s*([^\s#]+)\s*$/mu.exec(contents);
  if (!match) throw new Error(`Quality bar ${path} does not declare an id.`);
  return match[1];
}

async function qualityBars(root, files) {
  const bars = [];
  for (const file of files) {
    if (file.path.startsWith("checks/") && file.path.endsWith(".py")) {
      bars.push({
        id: `check:${file.path.slice("checks/".length, -".py".length).replaceAll("_", "-")}`,
        kind: "check",
        assetPath: file.path,
      });
      continue;
    }
    if (file.path.startsWith("rubrics/") && file.path.endsWith(".yaml")) {
      bars.push({
        id: `rubric:${parseYamlId(await readFile(resolve(root, file.path), "utf8"), file.path)}`,
        kind: "rubric",
        assetPath: file.path,
      });
      continue;
    }
    if (/^profiles\/[^/]+\/profile\.(?:json|yaml)$/u.test(file.path)) {
      const contents = await readFile(resolve(root, file.path), "utf8");
      const id = file.path.endsWith(".json")
        ? (() => {
            const profile = JSON.parse(contents);
            return profile.id ?? profile.profile_id;
          })()
        : parseYamlId(contents, file.path);
      if (typeof id !== "string" || !id) {
        throw new Error(`Quality bar ${file.path} does not declare an id.`);
      }
      bars.push({ id: `profile:${id}`, kind: "profile", assetPath: file.path });
    }
  }
  return bars.sort((left, right) => left.id.localeCompare(right.id));
}

function profileVersion(contents, path) {
  if (path.endsWith(".json")) {
    const profile = JSON.parse(contents);
    return profile.version ?? profile.profile_version;
  }
  return /^version:\s*([^\s#]+)\s*$/mu.exec(contents)?.[1];
}

/** Pin C digest of one resource: sha256-lines over its locked files in path order. */
export function resourceSha256(paths, files) {
  const byPath = new Map(files.map((file) => [file.path, file]));
  return bundleSha256(
    [...paths].sort((left, right) => left.localeCompare(right)).map((path) => byPath.get(path)),
  );
}

/**
 * Resolve the product-default declaration against the locked payload. Each
 * named profile must be a packaged profile bar with a version, and each named
 * file must sit in that profile's directory.
 */
async function productDefaults(root, files, bars) {
  const declarationPath = PRODUCT_DEFAULT_DECLARATION_PATH;
  const refuse = (detail) => {
    throw new Error(`Product-default declaration ${declarationPath} ${detail}`);
  };
  const lockedPaths = new Set(files.map((file) => file.path));
  if (!lockedPaths.has(declarationPath)) refuse("is missing from the quality payload.");
  const exactKeys = (value, keys, label) => {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())
    ) {
      refuse(`has an unsupported ${label} shape; expected exactly ${keys.join(", ")}.`);
    }
  };
  const declaration = JSON.parse(await readFile(resolve(root, declarationPath), "utf8"));
  exactKeys(
    declaration,
    ["schema_version", "kind", "layer", "style_profile", "evaluation_profile"],
    "root",
  );
  if (
    declaration.schema_version !== "1.0" ||
    declaration.kind !== "docsfab-product-default-resources" ||
    declaration.layer !== "product"
  ) {
    refuse("must declare schema_version 1.0, its kind, and layer product.");
  }
  const profile = async (entry, keys, label) => {
    exactKeys(entry, keys, label);
    const bar = bars.find((candidate) => candidate.id === entry.bar_id);
    if (!bar || bar.kind !== "profile") {
      refuse(`names ${label} ${JSON.stringify(entry.bar_id)}, which is not a packaged profile.`);
    }
    const version = profileVersion(
      await readFile(resolve(root, bar.assetPath), "utf8"),
      bar.assetPath,
    );
    if (typeof version !== "string" || !version) {
      refuse(`names ${bar.id}, whose profile declares no version.`);
    }
    const directory = bar.assetPath.slice(0, bar.assetPath.lastIndexOf("/"));
    const member = (name) => {
      if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name)) {
        refuse(`names a ${label} file that is not a plain file name in ${directory}.`);
      }
      const path = `${directory}/${name}`;
      if (!lockedPaths.has(path)) refuse(`names ${path}, which is not in the quality payload.`);
      return path;
    };
    return {
      fields: {
        barId: bar.id,
        profileId: bar.id.slice("profile:".length),
        version,
        assetPath: bar.assetPath,
      },
      member,
    };
  };
  const style = await profile(
    declaration.style_profile,
    ["bar_id", "delivered_files"],
    "style_profile",
  );
  if (
    !Array.isArray(declaration.style_profile.delivered_files) ||
    declaration.style_profile.delivered_files.length === 0
  ) {
    refuse("must name at least one delivered style_profile file.");
  }
  const deliveredPaths = declaration.style_profile.delivered_files.map(style.member);
  if (new Set(deliveredPaths).size !== deliveredPaths.length) {
    refuse("names one delivered style_profile file more than once.");
  }
  const evaluation = await profile(
    declaration.evaluation_profile,
    ["bar_id", "reader_impact_baseline"],
    "evaluation_profile",
  );
  const readerImpactBaselinePath = evaluation.member(
    declaration.evaluation_profile.reader_impact_baseline,
  );
  return {
    declarationPath,
    layer: "product",
    style: {
      ...style.fields,
      deliveredPaths,
      sha256: resourceSha256([style.fields.assetPath, ...deliveredPaths], files),
    },
    evaluation: {
      ...evaluation.fields,
      readerImpactBaselinePath,
      sha256: resourceSha256([evaluation.fields.assetPath, readerImpactBaselinePath], files),
    },
  };
}

/** Build the runtime quality lock for one quality source tree. */
export async function buildRuntimeQualityLock(root = sourceRoot) {
  const files = await sourceFiles(root);
  const bars = await qualityBars(root, files);
  return {
    schemaVersion: 2,
    bundleHashFormat: "sha256-lines-v1",
    source: {
      repository: SOURCE_REPO,
      revision: sourceContentRevision(files),
      path: "packages/quality",
    },
    qualityRoot: ".",
    bars,
    productDefaults: await productDefaults(root, files, bars),
    bundleSha256: bundleSha256(files),
    files,
  };
}

function sourceContentRevision(files) {
  return sha256(
    JSON.stringify({
      kind: "docsfab-quality-pack-content/v1",
      files: [...files]
        .sort((left, right) => left.path.localeCompare(right.path))
        .map(({ path, sha256: digest }) => ({ path, sha256: digest })),
    }),
  );
}

async function stagedFiles() {
  const files = await listFiles(qualityRoot);
  return Promise.all(
    files
      .filter((path) => path !== "lock.json")
      .map(async (path) => ({
        path,
        sha256: sha256(await readFile(resolve(qualityRoot, path))),
      })),
  );
}

async function stageQualityAssets() {
  await rm(qualityRoot, { recursive: true, force: true });
  await mkdir(qualityRoot, { recursive: true });
  for (const root of SOURCE_ROOTS) {
    await cp(resolve(sourceRoot, root), resolve(qualityRoot, root), {
      recursive: true,
      filter: (path) =>
        !relative(resolve(sourceRoot, root), path).split("/").includes("__pycache__") &&
        !SOURCE_ONLY_FILES.has(`${root}/${relative(resolve(sourceRoot, root), path)}`),
    });
  }
  for (const [path, source] of Object.entries(RUNTIME_POLICY_FILES)) {
    await cp(resolve(sourceRoot, source), resolve(qualityRoot, path));
  }
}

async function main() {
  const checkOnly = process.argv.length === 3 && process.argv[2] === "--check";
  if (process.argv.length > (checkOnly ? 3 : 2)) {
    throw new Error("Quality-pack generation accepts only the optional --check flag.");
  }

  const qualityLock = await buildRuntimeQualityLock();
  const { bars, files } = qualityLock;
  const serializedQualityLock = `${JSON.stringify(qualityLock, null, 2)}\n`;
  const skillLockBytes = await readFile(skillLockPath);
  const skillLock = JSON.parse(skillLockBytes);
  const skillIds = skillLock.skills.map((skill) => skill.id);
  const barIds = bars.map((bar) => bar.id);
  const skillLockSha256 = sha256(skillLockBytes);
  const qualityLockSha256 = sha256(serializedQualityLock);
  const packManifest = {
    schemaVersion: 1,
    id: "docsfab-default",
    version: "1.0.0",
    skillCrate: {
      lockPath: "../skill-crate/lock.json",
      lockSha256: skillLockSha256,
      skillIds,
    },
    quality: {
      lockPath: "../quality/lock.json",
      lockSha256: qualityLockSha256,
      bundleSha256: qualityLock.bundleSha256,
      barIds,
    },
    bindingSha256: sha256(`${skillLockSha256}\n${qualityLockSha256}\n`),
  };
  const serializedPackManifest = `${JSON.stringify(packManifest, null, 2)}\n`;

  if (checkOnly) {
    if ((await readFile(qualityLockPath, "utf8")) !== serializedQualityLock) {
      throw new Error("Runtime quality lock is stale; run npm run generate:quality-pack.");
    }
    if ((await readFile(packManifestPath, "utf8")) !== serializedPackManifest) {
      throw new Error("B+C quality-pack manifest is stale; run npm run generate:quality-pack.");
    }
    if (JSON.stringify(await stagedFiles()) !== JSON.stringify(files)) {
      throw new Error("Runtime quality payload differs from canonical packages/quality assets.");
    }
    console.log(`Quality pack is current: ${skillIds.length} skills, ${barIds.length} bars`);
  } else {
    await stageQualityAssets();
    await mkdir(packRoot, { recursive: true });
    await writeFile(qualityLockPath, serializedQualityLock);
    await writeFile(packManifestPath, serializedPackManifest);
    console.log(`Updated quality pack: ${skillIds.length} skills, ${barIds.length} bars`);
  }
}

// Realpath both sides: import.meta.url is symlink-resolved and argv[1] is not,
// so a linked invocation would otherwise exit 0 having checked nothing.
if (
  process.argv[1] &&
  realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))
) {
  await main();
}
