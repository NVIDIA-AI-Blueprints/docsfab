#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  CATALOG_SKILL_IDS,
  CATALOG_WRITE_SKILL_IDS,
  CATALOG_INVOCATION_CONTRACT_SKILL_IDS,
  catalogSkillSourcePath,
} from "../src/skills/catalog-ids.js";
/**
 * Copy the closed public catalog from packages/skills into the packaged
 * runtime skill crate and replace its deterministic lock. Workflow step ids,
 * not filesystem discovery or operator enablement, select these bytes.
 *
 * Usage:
 *   node scripts/generate-catalog-crate.mjs
 *   node scripts/generate-catalog-crate.mjs --check
 */
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CATALOG_SOURCE_ROOT,
  KNOWLEDGE_CATALOG_SKILL_IDS,
  KNOWLEDGE_CATALOG_SOURCE_ROOT,
} from "./derived-products.mjs";

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(runtimeRoot, "../..");
const catalogRoot = resolve(repoRoot, CATALOG_SOURCE_ROOT);
const knowledgeCatalogRoot = resolve(repoRoot, KNOWLEDGE_CATALOG_SOURCE_ROOT);
const KNOWLEDGE_SKILL_IDS = new Set(KNOWLEDGE_CATALOG_SKILL_IDS);
const crateRoot = resolve(runtimeRoot, "skill-crate");
const lockPath = resolve(crateRoot, "lock.json");
// The public repository: the internal and exported trees stamp the same
// identity, and each revision is a content digest rather than a commit.
const SOURCE_REPO = "https://github.com/NVIDIA-AI-Blueprints/docsfab.git";
const WRITE_SKILLS = new Set(CATALOG_WRITE_SKILL_IDS);
const SKIP_DIR_NAMES = new Set(["agents"]);
const INVOCATION_CONTRACT_SKILL_IDS = new Set(CATALOG_INVOCATION_CONTRACT_SKILL_IDS);
const INVOCATION_METADATA_FILE = "invocation.json";

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function bundleSha256(files) {
  return sha256(
    [...files]
      .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
      .map((file) => `${file.sha256}  ${file.path}\n`)
      .join(""),
  );
}

async function listFiles(directory, prefix = "") {
  const entries = await readdir(join(directory, prefix), {
    withFileTypes: true,
  });
  const files = [];
  for (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) {
      throw new Error(`Catalog skill source contains a symbolic link: ${path}`);
    }
    if (SKIP_DIR_NAMES.has(entry.name) || entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) {
      files.push(...(await listFiles(directory, path)));
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Catalog skill source contains an unsupported node: ${path}`);
    }
    files.push(path);
  }
  return files.sort();
}

function catalogSourceContentRevision(id, files) {
  return sha256(
    JSON.stringify({
      kind: "docsfab-catalog-skill-content/v1",
      id,
      files: [...files]
        .sort((left, right) => left.path.localeCompare(right.path))
        .map(({ path, sha256: digest }) => ({ path, sha256: digest })),
    }),
  );
}

/**
 * A catalog skill's declared tools must be the canonical tool ids the harness
 * registers; a call to an unregistered name wastes a turn on a synthetic
 * "not found" result. Retired Claude-style names correspond one-for-one (Glob
 * to the confined `find`). `verifyCatalogSkill` fails closed on any declared
 * name outside the granted set.
 */
function readOnlyPolicy() {
  return {
    declared: ["read", "grep", "find"],
    granted: ["read", "grep", "find", "ls"],
    withheld: ["edit", "write", "bash"],
  };
}

function writePolicy() {
  return {
    declared: ["read", "grep", "find", "edit", "write"],
    granted: ["read", "grep", "find", "ls", "edit", "write"],
    withheld: ["bash"],
  };
}

/**
 * The crate records the license each canonical SKILL.md declares in its
 * frontmatter, so the lock and the shipped skill bytes cannot disagree.
 */
async function declaredSkillLicense(id, source) {
  const text = await readFile(resolve(source, "SKILL.md"), "utf8");
  const frontmatter = /^---\n([\s\S]*?)\n---\n/u.exec(text)?.[1] ?? "";
  const license = /^license:[ \t]*(\S.*?)[ \t]*$/mu.exec(frontmatter)?.[1];
  if (!license) {
    throw new Error(`Catalog skill "${id}" SKILL.md frontmatter must declare a license.`);
  }
  return license;
}

function catalogSkillTemplate(id, revision, files, license) {
  const write = WRITE_SKILLS.has(id);
  const toolPolicy = write ? writePolicy() : readOnlyPolicy();
  const skillFile = files.find((file) => file.path === "SKILL.md");
  if (!skillFile) throw new Error(`Catalog skill "${id}" is missing SKILL.md.`);
  return {
    id,
    version: "0.1.0-docsfab-catalog.1",
    license,
    provenanceStatus: "docsfab-local",
    source: {
      repository: SOURCE_REPO,
      revision,
    },
    sourcePath: catalogSkillSourcePath(id),
    skillRoot: id,
    contentSha256: skillFile.sha256,
    bundleSha256: bundleSha256(files),
    files,
    inputs: KNOWLEDGE_SKILL_IDS.has(id)
      ? [
          {
            name: "approved_baseline",
            description: "Exact approved model generation, claims, canon and authority receipt",
          },
          {
            name: "source_evidence_chunk",
            description: "Exact before/after and attributed source evidence with declared coverage",
          },
        ]
      : [
          {
            name: "documentation_target",
            description: "Versioned documentation target for this catalog skill",
          },
          {
            name: "quality_profile",
            description: "Selected quality profile, rubric, or brief identity",
          },
        ],
    outputs: [
      {
        name: "skill_result",
        description: "Catalog skill result artifact or findings",
      },
      {
        name: "selection_rationale",
        description: "Catalog skill identity recorded for this run",
      },
    ],
    toolPolicy,
  };
}

async function assertInvocationMetadata(id, directory) {
  const invocationPath = resolve(directory, INVOCATION_METADATA_FILE);
  let raw;
  try {
    raw = await readFile(invocationPath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      if (INVOCATION_CONTRACT_SKILL_IDS.has(id)) {
        throw new Error(`Catalog skill "${id}" is missing ${INVOCATION_METADATA_FILE}.`);
      }
      return;
    }
    throw error;
  }
  if (!INVOCATION_CONTRACT_SKILL_IDS.has(id)) {
    throw new Error(`Catalog skill "${id}" must not ship invocation metadata in this slice.`);
  }
  let metadata;
  try {
    metadata = JSON.parse(raw);
  } catch {
    throw new Error(`Catalog skill "${id}" invocation metadata is not valid JSON.`);
  }
  if (
    !metadata ||
    metadata.schemaVersion !== 1 ||
    metadata.skillId !== id ||
    !Array.isArray(metadata.profiles) ||
    metadata.profiles.length === 0
  ) {
    throw new Error(`Catalog skill "${id}" invocation metadata failed closed validation.`);
  }
}

async function copySkill(id) {
  const source = resolve(KNOWLEDGE_SKILL_IDS.has(id) ? knowledgeCatalogRoot : catalogRoot, id);
  const destination = resolve(crateRoot, id);
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await cp(source, destination, {
    recursive: true,
    filter: (path) => !relative(source, path).split("/").includes("agents"),
  });
  const names = await listFiles(destination);
  const files = [];
  for (const path of names) {
    const bytes = await readFile(resolve(destination, path));
    files.push({ path, sha256: sha256(bytes) });
  }
  return files;
}

async function assertClosedCatalog() {
  const entries = await readdir(catalogRoot, { withFileTypes: true });
  const actual = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      await stat(join(catalogRoot, entry.name, "SKILL.md"));
      actual.push(entry.name);
    } catch {
      // Supporting directories without SKILL.md are not catalog entries.
    }
  }
  actual.sort();
  if (
    JSON.stringify(actual) !==
    JSON.stringify(CATALOG_SKILL_IDS.filter((id) => !KNOWLEDGE_SKILL_IDS.has(id)))
  ) {
    throw new Error(
      `Canonical packages/skills catalog does not match the closed runtime catalog: ${actual.join(", ")}`,
    );
  }
}

async function reconcileCrateDirectories(checkOnly) {
  await mkdir(crateRoot, { recursive: true });
  const entries = await readdir(crateRoot, { withFileTypes: true });
  const retired = entries
    .filter((entry) => entry.isDirectory() && !CATALOG_SKILL_IDS.includes(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (retired.length === 0) return;
  if (checkOnly) {
    throw new Error(`Catalog skill crate contains retired ids: ${retired.join(", ")}`);
  }
  for (const id of retired) {
    await rm(resolve(crateRoot, id), { recursive: true, force: true });
  }
}

const checkOnly = process.argv.length === 3 && process.argv[2] === "--check";
if (process.argv.length > (checkOnly ? 3 : 2)) {
  throw new Error("Catalog crate generation accepts only the optional --check flag.");
}
await assertClosedCatalog();
await reconcileCrateDirectories(checkOnly);
const skills = [];
for (const id of CATALOG_SKILL_IDS) {
  const source = resolve(KNOWLEDGE_SKILL_IDS.has(id) ? knowledgeCatalogRoot : catalogRoot, id);
  const files = checkOnly
    ? await Promise.all(
        (await listFiles(source)).map(async (path) => ({
          path,
          sha256: sha256(await readFile(resolve(source, path))),
        })),
      )
    : await copySkill(id);
  await assertInvocationMetadata(id, checkOnly ? source : resolve(crateRoot, id));
  skills.push(
    catalogSkillTemplate(
      id,
      catalogSourceContentRevision(id, files),
      files,
      await declaredSkillLicense(id, source),
    ),
  );
}
const lock = {
  schemaVersion: 1,
  bundleHashFormat: "sha256-lines-v1",
  contractHashFormat: "sha256-catalog-skill-contract-v1",
  skills,
};
const serializedLock = `${JSON.stringify(lock, null, 2)}\n`;
if (checkOnly) {
  if ((await readFile(lockPath, "utf8")) !== serializedLock) {
    throw new Error("Catalog skill crate lock is stale; run npm run generate:skill-crate.");
  }
  for (const skill of skills) {
    const stagedFiles = await Promise.all(
      (await listFiles(resolve(crateRoot, skill.id))).map(async (path) => ({
        path,
        sha256: sha256(await readFile(resolve(crateRoot, skill.id, path))),
      })),
    );
    if (JSON.stringify(stagedFiles) !== JSON.stringify(skill.files)) {
      throw new Error(
        `Catalog skill crate entry "${skill.id}" differs from packages/skills/${skill.id}.`,
      );
    }
  }
  console.log(`Catalog skill crate is current: ${CATALOG_SKILL_IDS.join(", ")}`);
} else {
  await writeFile(lockPath, serializedLock);
  console.log(`Updated catalog skill crate: ${CATALOG_SKILL_IDS.join(", ")}`);
}
