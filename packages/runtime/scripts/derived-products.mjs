// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PRIVATE_CONTENT_PATHS } from "../src/config/private-content-paths.js";
import { CATALOG_SKILL_METADATA } from "../src/skills/catalog-ids.js";
import {
  DEPLOY_ROOT_CONFIG_PATH,
  deployShellMirrorPath,
  loadDeployRoot,
} from "./limits-deploy-root.mjs";
/**
 * Shared source-of-truth for runtime derived products.
 *
 * Keep this module dependency-free: product generators may import it, while
 * contributor and CI helpers may use the product graph to select and repair
 * affected outputs.
 */

export const CATALOG_SOURCE_ROOT = "packages/skills";
export const KNOWLEDGE_CATALOG_SOURCE_ROOT = "packages/knowledge/skills";
export const KNOWLEDGE_CATALOG_SKILL_IDS = Object.freeze(
  CATALOG_SKILL_METADATA.filter((entry) => entry.sourceKind === "knowledge-procedure").map(
    (entry) => entry.id,
  ),
);
export const QUALITY_SOURCE_ROOT = "packages/quality";
export const QUALITY_RUNTIME_POLICY_ROOT = "runtime-policy";
export const QUALITY_RESOURCE_ROLES_PATH = "packages/runtime/src/quality-pack/resource-roles.js";
export const QUALITY_SOURCE_ROOTS = Object.freeze([
  "checks",
  "formats",
  "profiles",
  "rubrics",
  "schemas",
]);
export const COMPARISON_CORPUS_ROOT = PRIVATE_CONTENT_PATHS.modelComparisonSource;
export const DERIVED_DISTRIBUTION_PATH = "packages/runtime/src/config/private-content-paths.js";
export const DERIVED_PRODUCTS_DEFINITION_PATH = "packages/runtime/scripts/derived-products.mjs";
export const DERIVED_COORDINATOR_PATH = "packages/runtime/scripts/generate-derived.mjs";
export const DERIVED_PREFLIGHT_PATH = "packages/runtime/scripts/derived-preflight.mjs";

const runtime = "packages/runtime";

function glob(relativePath) {
  return `${relativePath}/**/*`;
}

const skillCrate = Object.freeze({
  id: "skill-crate",
  label: "Pin B catalog skill crate",
  inputs: Object.freeze([
    glob(CATALOG_SOURCE_ROOT),
    ...KNOWLEDGE_CATALOG_SKILL_IDS.map((id) => glob(`${KNOWLEDGE_CATALOG_SOURCE_ROOT}/${id}`)),
    "packages/runtime/scripts/generate-catalog-crate.mjs",
    "packages/runtime/src/skills/catalog-ids.ts",
    "packages/runtime/src/skills/catalog-ids.js",
    DERIVED_PRODUCTS_DEFINITION_PATH,
    DERIVED_DISTRIBUTION_PATH,
    DERIVED_COORDINATOR_PATH,
    DERIVED_PREFLIGHT_PATH,
  ]),
  outputs: Object.freeze([glob(`${runtime}/skill-crate`)]),
  dependencies: Object.freeze([]),
  script: "generate-catalog-crate.mjs",
  checkCommand: "npm run check:skill-crate",
  repairCommand: "npm run generate:skill-crate",
});

const qualityPack = Object.freeze({
  id: "quality-pack",
  label: "Pin C quality pack and B+C binding",
  inputs: Object.freeze([
    ...QUALITY_SOURCE_ROOTS.map((root) => glob(`${QUALITY_SOURCE_ROOT}/${root}`)),
    glob(`${QUALITY_SOURCE_ROOT}/${QUALITY_RUNTIME_POLICY_ROOT}`),
    QUALITY_RESOURCE_ROLES_PATH,
    "packages/runtime/scripts/generate-quality-pack.mjs",
    DERIVED_PRODUCTS_DEFINITION_PATH,
    DERIVED_DISTRIBUTION_PATH,
    DERIVED_COORDINATOR_PATH,
    DERIVED_PREFLIGHT_PATH,
  ]),
  outputs: Object.freeze([glob(`${runtime}/quality`), glob(`${runtime}/quality-pack`)]),
  dependencies: Object.freeze(["skill-crate"]),
  script: "generate-quality-pack.mjs",
  checkCommand: "npm run check:quality-pack",
  repairCommand: "npm run generate:quality-pack",
});

// The generated operational-limits doc tables are part of this product. Their
// directory and its generator are inputs so an edit to a generated table, or
// to the generator, is recognized as touching this product. The page that
// includes the tables is prose only and is deliberately absent: the generator
// never reads it, so a prose edit selects no runtime CI job. One directory
// glob keeps every table, including a future region, under one trigger entry.
// docs-limits-table.mjs names the same directory as TABLES_DIR; its test
// fails if the two disagree.
const limitsDocTables = glob("docs/reference/status-and-configuration/operational-limits-tables");
const trainReuseMetadataPath = ".gitlab/ci/train-reuse/metadata.mjs";
// The deploy shell mirror exists only where config/limits-deploy.json names a
// deploy root; the public export has neither.
const deployRoot = loadDeployRoot(resolve(dirname(fileURLToPath(import.meta.url)), "../../.."));
const limits = Object.freeze({
  id: "limits",
  label: "Operational limits mirrors",
  optionalOwnerInputs: Object.freeze([trainReuseMetadataPath]),
  inputs: Object.freeze([
    "config/limits.yaml",
    glob("config/limits"),
    "config/limits-allowlist.json",
    glob("config/limits-allowlist"),
    "packages/runtime/scripts/check-limits.mjs",
    "packages/runtime/scripts/docs-limits-table.mjs",
    limitsDocTables,
    "packages/runtime/scripts/limits-allowlist-shards.mjs",
    DEPLOY_ROOT_CONFIG_PATH,
    "packages/runtime/scripts/limits-deploy-root.mjs",
    trainReuseMetadataPath,
    // check-limits imports it to validate the catalog and host overrides.
    "packages/runtime/src/config/limit-resolution.js",
    DERIVED_PRODUCTS_DEFINITION_PATH,
    DERIVED_DISTRIBUTION_PATH,
  ]),
  outputs: Object.freeze([
    "packages/runtime/src/config/limits.generated.ts",
    "packages/knowledge/src/first-pass-limits.generated.mjs",
    ...(deployRoot === null ? [] : [deployShellMirrorPath(deployRoot)]),
    ".gitlab/ci/live-model-limits.generated.yml",
    ".gitlab/ci/wsl2-limits.generated.yml",
    ".gitlab/ci/nightly-limits.generated.yml",
    ".gitlab/ci/sast-limits.generated.yml",
    ".gitlab/ci/artifact-retention-limits.generated.yml",
    ".gitlab/ci/train-reuse/limits.generated.json",
    "config/limits.json",
    "config/limits.catalog.json",
    limitsDocTables,
  ]),
  dependencies: Object.freeze([]),
  script: "check-limits.mjs",
  checkCommand: "node scripts/check-limits.mjs --check",
  // The build generates the two code mirrors and git does not track them, so a
  // fresh checkout lacks them: checks of the checkout read committed outputs only.
  committedCheckArguments: Object.freeze(["--check", "--committed-only"]),
  repairCommand: "npm run generate:limits",
});

const envAdmission = Object.freeze({
  id: "env-admission",
  label: "Environment-admission mirrors",
  inputs: Object.freeze([
    "config/env-admission.yaml",
    "packages/runtime/scripts/check-env-admission.mjs",
    DERIVED_PRODUCTS_DEFINITION_PATH,
    DERIVED_DISTRIBUTION_PATH,
  ]),
  outputs: Object.freeze([
    "packages/runtime/src/config/env-admission.generated.ts",
    "packages/runtime/scripts/offline-test-env.generated.mjs",
    ".gitlab/ci/runtime-run-env.generated.sh",
  ]),
  dependencies: Object.freeze([]),
  script: "check-env-admission.mjs",
  checkCommand: "node scripts/check-env-admission.mjs --check",
  committedCheckArguments: Object.freeze(["--check", "--committed-only"]),
  repairCommand: "npm run generate:env-admission",
});

// The model-output rule catalog, including the response-contract key
// vocabulary mirror. It reads canonical sources only, never a staged product,
// so it depends on no product and runs before skill-crate and quality-pack.
const modelOutput = Object.freeze({
  id: "model-output",
  label: "Model-output rule catalog bindings",
  inputs: Object.freeze([
    glob("config/model-output"),
    "config/model-output-allowlist.json",
    "config/limits.yaml",
    glob("config/limits"),
    // check-model-output and every module it imports: it reads the catalog
    // through check-limits' loader.
    "packages/runtime/scripts/check-limits.mjs",
    "packages/runtime/scripts/check-model-output.mjs",
    "packages/runtime/scripts/docs-limits-table.mjs",
    "packages/runtime/scripts/lib/yaml-subset.mjs",
    "packages/runtime/scripts/limits-allowlist-shards.mjs",
    "packages/runtime/scripts/limits-deploy-root.mjs",
    "packages/runtime/src/config/limit-resolution.js",
    "packages/runtime/src/execution/response-contract-keys.js",
    "packages/runtime/src/operator/failure-class.ts",
    // The rejected replies each rule names; a missing one fails the check.
    glob(`${runtime}/test/fixtures/model-output`),
    glob(`${QUALITY_SOURCE_ROOT}/schemas`),
    glob(`${runtime}/workflows`),
    DERIVED_PRODUCTS_DEFINITION_PATH,
    DERIVED_DISTRIBUTION_PATH,
  ]),
  outputs: Object.freeze([
    "packages/runtime/src/contracts/model-output.generated.ts",
    "packages/knowledge/src/model-output.generated.mjs",
    "packages/runtime/src/execution/response-contract-vocabulary.generated.json",
    "packages/runtime/docs/reference/contracts/model-output-rules.md",
  ]),
  dependencies: Object.freeze([]),
  script: "check-model-output.mjs",
  checkCommand: "node scripts/check-model-output.mjs --check",
  committedCheckArguments: Object.freeze(["--check", "--committed-only"]),
  repairCommand: "npm run generate:model-output",
});

const modelComparisonKit = COMPARISON_CORPUS_ROOT
  ? Object.freeze({
      id: "model-comparison-kit",
      label: "Benchmark execution bindings and model comparison kit",
      inputs: Object.freeze([
        glob(COMPARISON_CORPUS_ROOT),
        glob(`${runtime}/workflows`),
        "packages/runtime/scripts/generate-model-comparison-kit.mjs",
        "packages/runtime/scripts/generate-model-comparison-kit-corpus.mjs",
        DERIVED_PRODUCTS_DEFINITION_PATH,
        DERIVED_DISTRIBUTION_PATH,
        DERIVED_COORDINATOR_PATH,
        DERIVED_PREFLIGHT_PATH,
      ]),
      outputs: Object.freeze([
        glob(`${runtime}/${PRIVATE_CONTENT_PATHS.modelComparisonInstalled}`),
      ]),
      // Campaign snapshots are generated from current machine pins, but skill and
      // quality factory MRs do not repair the kit. Relocatable export is a kit-job
      // concern, not a factory-loop dependent.
      dependencies: Object.freeze([]),
      script: "generate-model-comparison-kit.mjs",
      checkCommand: "npm run check:model-comparison-kit",
      repairCommand: "npm run generate:model-comparison-kit",
    })
  : null;

export const DERIVED_PRODUCTS = Object.freeze([
  limits,
  envAdmission,
  modelOutput,
  skillCrate,
  qualityPack,
  ...(modelComparisonKit ? [modelComparisonKit] : []),
]);
export const DERIVED_PRODUCT_BY_ID = Object.freeze(
  Object.fromEntries(DERIVED_PRODUCTS.map((product) => [product.id, product])),
);

export function productRepairCommands(productId, includeDependents = true) {
  const commands = [];
  const seen = new Set();
  const visit = (id) => {
    if (seen.has(id)) return;
    seen.add(id);
    const product = DERIVED_PRODUCT_BY_ID[id];
    if (!product) throw new Error(`Unknown derived product: ${id}`);
    commands.push(product.repairCommand);
    if (includeDependents) {
      for (const dependent of DERIVED_PRODUCTS) {
        if (dependent.dependencies.includes(id)) visit(dependent.id);
      }
    }
  };
  visit(productId);
  return commands;
}

function collectCiPathPatterns(products) {
  const patterns = new Set();
  for (const product of products) {
    for (const path of [...product.inputs, ...product.outputs]) patterns.add(path);
  }
  patterns.add(DERIVED_COORDINATOR_PATH);
  patterns.add(DERIVED_PREFLIGHT_PATH);
  return [...patterns];
}

export function derivedCiPathPatterns() {
  return collectCiPathPatterns(DERIVED_PRODUCTS);
}

export function derivedMachineCiPathPatterns() {
  return collectCiPathPatterns(
    DERIVED_PRODUCTS.filter((product) => product.id !== "model-comparison-kit"),
  );
}

export function derivedKitCiPathPatterns() {
  return collectCiPathPatterns(
    DERIVED_PRODUCTS.filter((product) => product.id === "model-comparison-kit"),
  );
}
