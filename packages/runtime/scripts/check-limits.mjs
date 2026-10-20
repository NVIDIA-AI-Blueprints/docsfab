#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Generate and verify DocsFab operational-limit mirrors from config/limits.yaml
 * (the fragment registry) and the per-owner fragments under config/limits/.
 *
 * Usage:
 *   node scripts/check-limits.mjs
 *   node scripts/check-limits.mjs --check [--gate]
 *     (--gate adds the literal-allowlist, rationale-budget, and bound-test checks)
 *   node scripts/check-limits.mjs --check --scope runtime|host|deploy   (implies the gate)
 *   node scripts/check-limits.mjs --write-allowlist   (rewrites config/limits-allowlist/ shards)
 *   node scripts/check-limits.mjs --check-host-file /path/to/service.env
 *   node scripts/check-limits.mjs --print-mirror-paths   (lists the generated mirror paths)
 */
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertDiskHeadroomOrder,
  assertSecretsLockOrder,
  parseHostLimitAssignments,
  resolveHostLimitOverrides,
  resolveLimitDefinitions,
} from "../src/config/limit-resolution.js";
// The generated operational-limits doc tables. The renderer reads
// config/limits.catalog.json, not the fragment sources this file parses.
import { TABLE_PATHS as LIMITS_DOC_TABLE_PATHS, runDocsLimitsTool } from "./docs-limits-table.mjs";
import {
  ALLOWLIST_ROOT_PATH,
  ALLOWLIST_SHARD_DIR,
  loadAllowlistForRewrite,
  loadAllowlistShards,
  renderAllowlistFiles,
  shardFileForOwner,
  shardPathForLiteral,
} from "./limits-allowlist-shards.mjs";
import {
  DEPLOY_ROOT_CONFIG_PATH,
  deployShellMirrorPath,
  loadDeployRoot,
} from "./limits-deploy-root.mjs";

const require = createRequire(new URL("../package.json", import.meta.url));

export function loadYamlParse() {
  try {
    return require("yaml").parse;
  } catch (error) {
    if (error?.code === "MODULE_NOT_FOUND" || error?.code === "ERR_MODULE_NOT_FOUND") return null;
    throw error;
  }
}

const TS_LINE_WIDTH = 100;

// Top-level keys whose value is a block list of unquoted mappings: the root
// registry's `fragments:` and each fragment's `limits:`.
const SUBSET_LIST_KEYS = new Set(["limits", "fragments"]);

/**
 * Parse the constrained limits catalog shape without the npm `yaml` package:
 * comments, top-level scalars, and block lists (`limits:` in a fragment,
 * `fragments:` in the root registry) of unquoted mappings. Used by
 * `runtime:derived:preflight`, which runs before `npm ci`. `source` names the
 * document in every syntax refusal.
 */
export function parseLimitsYamlSubset(text, source = YAML_PATH) {
  const lines = text.split(/\r?\n/u);
  const root = {};
  let list = null;
  let current = null;
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (raw.includes("\t")) {
      throw new Error(`${source}: tabs are not in the preflight subset (line ${index + 1})`);
    }
    const indent = raw.length - raw.trimStart().length;
    if (trimmed.startsWith("- ")) {
      if (indent !== 2 || list === null) {
        throw new Error(`${source}: unexpected list item at line ${index + 1}`);
      }
      current = {};
      list.push(current);
      assignMappingField(current, trimmed.slice(2), index + 1, source);
      continue;
    }
    if (indent === 0) {
      current = null;
      list = null;
      const { key, value, hasValue } = splitKeyValue(trimmed, index + 1, source);
      if (SUBSET_LIST_KEYS.has(key)) {
        if (hasValue) {
          throw new Error(`${source}: ${key} must be a block list`);
        }
        list = [];
        root[key] = list;
        continue;
      }
      root[key] = decodeScalar(value, index + 1, source);
      continue;
    }
    if (indent === 4 && current) {
      assignMappingField(current, trimmed, index + 1, source);
      continue;
    }
    throw new Error(`${source}: unsupported syntax at line ${index + 1}`);
  }
  return root;
}

function splitKeyValue(trimmed, line, source) {
  const match = /^([A-Za-z][A-Za-z0-9_.]*):(?:\s+(.*))?$/u.exec(trimmed);
  if (!match) {
    throw new Error(`${source}: expected key: value at line ${line}`);
  }
  const value = match[2] ?? "";
  return { key: match[1], value, hasValue: value.length > 0 };
}

function assignMappingField(target, trimmed, line, source) {
  const { key, value, hasValue } = splitKeyValue(trimmed, line, source);
  if (!hasValue) {
    throw new Error(`${source}: missing value for ${key} at line ${line}`);
  }
  target[key] = decodeScalar(value, line, source);
}

function decodeScalar(raw, line, source) {
  if (raw === "null" || raw === "~") return null;
  if (/^-?\d+$/u.test(raw)) return Number(raw);
  if (/^-?(?:\d+\.\d*|\.\d+)$/u.test(raw)) return Number(raw);
  if (
    raw.startsWith("|") ||
    raw.startsWith(">") ||
    raw.startsWith("'") ||
    raw.startsWith('"') ||
    raw.startsWith("[") ||
    raw.startsWith("{") ||
    raw.startsWith("&") ||
    raw.startsWith("*") ||
    raw.startsWith("!")
  ) {
    throw new Error(`${source}: unsupported scalar at line ${line}`);
  }
  return raw;
}

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(runtimeRoot, "../..");
const YAML_PATH = "config/limits.yaml";
// Per-owner fragments registered by YAML_PATH. Flat: no subdirectories.
const FRAGMENT_DIR = "config/limits";
// A directory entry that could be mistaken for a fragment. Anything else
// (.DS_Store, README.md, an editor's `host.yaml~`) is not read and not refused.
const FRAGMENT_FILE_RE = /\.ya?ml$/iu;
const FRAGMENT_OWNER_RE = /^[A-Za-z][A-Za-z0-9]*$/u;
// Root registry of the allowlist shards under ALLOWLIST_SHARD_DIR.
const ALLOWLIST_PATH = ALLOWLIST_ROOT_PATH;
const RUNTIME_GENERATED = "packages/runtime/src/config/limits.generated.ts";
// The knowledge first pass cannot import runtime code (`knowledge -> runtime`),
// so its `firstPass.*` catalog defaults come from this mirror. The runtime
// host still resolves host overrides and passes the effective values in.
export const KNOWLEDGE_FIRST_PASS_GENERATED =
  "packages/knowledge/src/first-pass-limits.generated.mjs";
/**
 * Code mirrors the build generates and git does not track; `--committed-only`
 * does not check them. Exact paths: the deploy shell mirror shares their
 * basename shape and stays committed and checked.
 */
export const BUILD_GENERATED_MIRRORS = Object.freeze([
  RUNTIME_GENERATED,
  KNOWLEDGE_FIRST_PASS_GENERATED,
]);
const KNOWLEDGE_PACKAGE_PATH = "packages/knowledge";
const FIRST_PASS_LIMIT_PREFIX = "firstPass.";
const GITLAB_LIVE_MODEL_GENERATED = ".gitlab/ci/live-model-limits.generated.yml";
const GITLAB_WSL2_GENERATED = ".gitlab/ci/wsl2-limits.generated.yml";
const GITLAB_NIGHTLY_GENERATED = ".gitlab/ci/nightly-limits.generated.yml";
const GITLAB_SAST_LIMITS_GENERATED = ".gitlab/ci/sast-limits.generated.yml";
const GITLAB_ARTIFACT_RETENTION_GENERATED = ".gitlab/ci/artifact-retention-limits.generated.yml";
const BLUEPRINT_COMPLIANCE_PATH = ".gitlab/ci/blueprint-compliance.yml";
const GITLAB_CI_ROOT_PATH = ".gitlab-ci.yml";
const GITLAB_RUNTIME_PATH = ".gitlab/ci/runtime.yml";
const GITLAB_KNOWLEDGE_PATH = ".gitlab/ci/knowledge.yml";
const GITLAB_PUBLIC_EXPORT_PATH = ".gitlab/ci/public-export.yml";
const JSON_MIRROR = "config/limits.json";
// JSON_MIRROR has a fixed shape its host reader validates exactly. This is the
// generated whole-catalog export, keyed by name and at parity with
// `LIMIT_DEFINITIONS`, for non-JS/TS consumers such as the Python `checker.py`.
const CATALOG_JSON_MIRROR = "config/limits.catalog.json";
const TRAIN_REUSE_LIMITS_GENERATED = ".gitlab/ci/train-reuse/limits.generated.json";
const TRAIN_REUSE_LIMITS_CONSUMER = ".gitlab/ci/train-reuse/metadata.mjs";
const TRAIN_REUSE_SOURCE_PATHS = Object.freeze([
  YAML_PATH,
  `${FRAGMENT_DIR}/ci.yaml`,
  "packages/runtime/scripts/check-limits.mjs",
]);
export const LIVE_MODEL_JOB_TIMEOUT_LIMIT = "ci.liveModel.jobTimeoutMs";
export const NIGHTLY_JOB_TIMEOUT_LIMIT = "nightly.ciJobTimeoutMs";
export const NIGHTLY_SCRIPT_TIMEOUT_LIMIT = "nightly.ciScriptTimeoutMs";
export const NIGHTLY_CI_ARM_RETRIES_LIMIT = "nightly.ciArmAutomaticRetries";
export const LIVE_MODEL_EVIDENCE_RETENTION_LIMIT = "ci.liveModel.evidenceRetentionDays";
// The journey gate's and the acceptance run's own ceilings, separate because
// neither fits the shared live-model job timeout, and raising that would also
// let more workflow-canary rounds start.
export const LIVE_JOURNEY_JOB_TIMEOUT_LIMIT = "ci.liveJourney.jobTimeoutMs";
export const LIVE_MODEL_ACCEPTANCE_JOB_TIMEOUT_LIMIT = "ci.liveModelAcceptance.jobTimeoutMs";
export const WSL2_JOB_TIMEOUT_LIMIT = "ci.wsl2.jobTimeoutMs";
export const WSL2_AUTOMATIC_RETRIES_LIMIT = "ci.wsl2.automaticRetries";
export const ARTIFACT_HANDOFF_RETENTION_LIMIT = "ci.artifacts.handoffRetentionDays";
export const ARTIFACT_REPORT_RETENTION_LIMIT = "ci.artifacts.reportRetentionDays";
// Jobs whose artifact expiry comes from the generated retention include.
// Every other expire_in: in these files is refused, so a new job cannot
// reintroduce a hand-declared retention literal.
export const GITLAB_ARTIFACT_RETENTION_JOBS = Object.freeze({
  [GITLAB_RUNTIME_PATH]: Object.freeze([
    ["runtime:prepare", ".ci_handoff_artifacts"],
    ["runtime:test", ".ci_handoff_artifacts"],
    [".runtime_isolation", ".ci_handoff_artifacts"],
    ["runtime:package:verify", ".ci_handoff_artifacts"],
    ["runtime:smoke", ".ci_report_artifacts"],
    ["runtime:coverage", ".ci_report_artifacts"],
    ["runtime:comparison-model", ".ci_report_artifacts"],
  ]),
  [GITLAB_KNOWLEDGE_PATH]: Object.freeze([["documentation:freshness", ".ci_report_artifacts"]]),
  [GITLAB_PUBLIC_EXPORT_PATH]: Object.freeze([["public-export:dry-run", ".ci_report_artifacts"]]),
});
export const SAST_SEMGREP_TIMEOUT_LIMIT = "ci.sast.semgrepRuleTimeoutSeconds";
// GitLab job `variables:` deep-merge across includes, but `extends:` is
// replaced wholesale; an `extends:` on the semgrep-sast override would discard
// the template's `.sast-analyzer` script and image. So the bound is a
// same-named `semgrep-sast:` stanza in a generated include that adds one
// `variables:` key, consumed by interpolation.
export const SAST_SEMGREP_TIMEOUT_VARIABLE = "SEMGREP_RULE_TIMEOUT_SECONDS";
export const SAST_MAX_TARGET_BYTES_LIMIT = "ci.sast.maxTargetBytes";
// Same projection for --max-target-bytes, which the pinned analyzer's
// allowedCliOpts accepts (governance/security/sast-baseline.md). Both variable
// names are repo-chosen interpolation carriers, not analyzer-native env vars.
export const SAST_MAX_TARGET_BYTES_VARIABLE = "SEMGREP_MAX_TARGET_BYTES";
const BOUNDS_TEST = "packages/runtime/test/limits-bounds.test.ts";
const REGISTRY_PATH = "packages/runtime/model-compositions/composition-registry.json";
const SCOPES = new Set(["per-run", "per-host", "per-project", "sealed"]);
const SEALED_FIELDS = Object.freeze([
  "contextWindow",
  "maxInputTokens",
  "maxOutputTokens",
  "maxProviderTurns",
  "maxResponseBytes",
  "timeoutMs",
]);
/** The deploy scan root config/limits-deploy.json declares under `root`, or null. */
function configuredDeployRoot(root = repoRoot) {
  return loadDeployRoot(root);
}

/**
 * The directories each scope scans. The deploy scope's root comes from
 * config/limits-deploy.json, so a tree without that file (the public export)
 * has no deploy root at all.
 */
function productScanRoots(deployRoot) {
  return Object.freeze({
    runtime: ["packages/runtime/src"],
    host: ["packages/host/src"],
    deploy: deployRoot === null ? [] : [deployRoot],
  });
}

function allScanRoots(deployRoot) {
  return Object.values(productScanRoots(deployRoot)).flat();
}

/** The allowlist shard row the deploy configuration registers. */
function configuredShards(deployRoot) {
  return deployRoot === null
    ? []
    : [{ file: shardFileForOwner(deployRoot), owner: deployRoot, source: DEPLOY_ROOT_CONFIG_PATH }];
}

// The skip line for a deploy part when no deploy root is configured.
function deployUnconfiguredSkip(subject) {
  return `${subject}: skipped, ${DEPLOY_ROOT_CONFIG_PATH} is absent from this tree, so no deploy root is configured`;
}

/**
 * Mirrors kept only for a consumer outside the product packages, keyed to
 * that consumer. A tree without the consumer (the public export) skips the
 * mirror by name; with the consumer present, a missing or stale mirror still
 * refuses.
 */
function mirrorOwners(deployRoot) {
  return Object.freeze({
    ...(deployRoot === null ? {} : { [deployShellMirrorPath(deployRoot)]: deployRoot }),
    [KNOWLEDGE_FIRST_PASS_GENERATED]: KNOWLEDGE_PACKAGE_PATH,
    [GITLAB_LIVE_MODEL_GENERATED]: GITLAB_CI_ROOT_PATH,
    [GITLAB_WSL2_GENERATED]: GITLAB_CI_ROOT_PATH,
    [GITLAB_NIGHTLY_GENERATED]: GITLAB_CI_ROOT_PATH,
    [GITLAB_SAST_LIMITS_GENERATED]: GITLAB_CI_ROOT_PATH,
    [GITLAB_ARTIFACT_RETENTION_GENERATED]: GITLAB_CI_ROOT_PATH,
    [TRAIN_REUSE_LIMITS_GENERATED]: TRAIN_REUSE_LIMITS_CONSUMER,
  });
}
const CHECKER_PATH = "packages/runtime/scripts/check-limits.mjs";
const ALLOWLIST_SHARDS_MODULE_PATH = "packages/runtime/scripts/limits-allowlist-shards.mjs";
const DEPLOY_ROOT_MODULE_PATH = "packages/runtime/scripts/limits-deploy-root.mjs";
const GENERATED_NAMES = new Set([
  "limits.generated.ts",
  "first-pass-limits.generated.mjs",
  "limits.generated.sh",
  "live-model-limits.generated.yml",
  "wsl2-limits.generated.yml",
  "nightly-limits.generated.yml",
  "sast-limits.generated.yml",
  "artifact-retention-limits.generated.yml",
  "limits.generated.json",
  "limits.json",
  "limits.catalog.json",
  "limits.yaml",
  "limits-allowlist.json",
  "check-limits.mjs",
]);

const BOUND_PATTERNS = Object.freeze([
  { kind: "kib-product", regex: /\b\d+\s*\*\s*1024\b/gu },
  { kind: "length-gt", regex: /\.length\s*>\s*\d{2,}/gu },
  { kind: "slice-cap", regex: /\.slice\(\s*0\s*,\s*\d+\s*\)/gu },
  { kind: "max-buffer", regex: /\bmaxBuffer\s*[:=,]?\s*\d/gu },
  { kind: "per-page", regex: /\bper_page=\d/gu },
]);
const IDENT_ASSIGN_RE = /\b([A-Za-z_][A-Za-z0-9_]*)\s*[:=]\s*\d/gu;
const BOUND_KEYWORD_SEGMENTS = Object.freeze([
  "max",
  "min",
  "limit",
  "budget",
  "timeout",
  "window",
]);
const MAX_FAMILY_SEGMENTS = Object.freeze(["max", "min", "limit", "budget", "bytes"]);
const NOISY_SINGLE_SEGMENTS = new Set(["max", "min", "ms", "bytes"]);

/**
 * Split an identifier on underscores and camelCase / SCREAMING_CASE seams.
 * `MAX_FOO_BYTES`, `maxFooBytes`, and `WINDOW_MS` become comparable segments.
 */
export function identifierSegments(name) {
  return name
    .replaceAll(/([a-z0-9])([A-Z])/gu, "$1\0$2")
    .replaceAll(/([A-Z]+)([A-Z][a-z])/gu, "$1\0$2")
    .split(/[\0_]+/u)
    .map((part) => part.toLowerCase())
    .filter(Boolean);
}

/**
 * Classify a numeric assignment as a bound, independent of identifier casing
 * and independent of whether the literal uses a digit separator. Digit
 * grouping alone is not a bound. Bare `max:` / `min:` object fields are not.
 * A trailing `ms`/`bytes` segment counts only for `*_MS`/`*_BYTES` names or
 * when a bound keyword is already present (`timeoutMs`, `maxFooBytes`).
 *
 * @returns {"max-assign" | "timeout-assign" | null}
 */
export function boundAssignKind(identifier) {
  const segments = identifierSegments(identifier);
  if (segments.length === 0) return null;
  if (segments.length === 1 && NOISY_SINGLE_SEGMENTS.has(segments[0])) return null;
  const last = segments[segments.length - 1];
  const hasKeyword = segments.some((segment) => BOUND_KEYWORD_SEGMENTS.includes(segment));
  const underscored = identifier.includes("_");
  const hasBoundSuffix = (last === "ms" || last === "bytes") && (underscored || hasKeyword);
  if (!hasKeyword && !hasBoundSuffix) return null;
  if (segments.some((segment) => MAX_FAMILY_SEGMENTS.includes(segment)) || last === "bytes") {
    return "max-assign";
  }
  return "timeout-assign";
}

/** Match bound literals in one source string. Path is attached by the scanner. */
export function matchBoundLiterals(source) {
  const findings = [];
  for (const pattern of BOUND_PATTERNS) {
    pattern.regex.lastIndex = 0;
    let match = pattern.regex.exec(source);
    while (match) {
      findings.push({
        kind: pattern.kind,
        lexeme: normalizeLexeme(match[0]),
      });
      match = pattern.regex.exec(source);
    }
  }
  IDENT_ASSIGN_RE.lastIndex = 0;
  let identMatch = IDENT_ASSIGN_RE.exec(source);
  while (identMatch) {
    const kind = boundAssignKind(identMatch[1]);
    if (kind) {
      findings.push({
        kind,
        lexeme: normalizeLexeme(identMatch[0]),
      });
    }
    identMatch = IDENT_ASSIGN_RE.exec(source);
  }
  return findings;
}

export function parseArgs(argv) {
  const options = {
    checkOnly: false,
    writeAllowlist: false,
    gate: false,
    scope: "all",
    hostFile: null,
    printMirrorPaths: false,
    committedOnly: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") {
      options.checkOnly = true;
      continue;
    }
    if (argument === "--committed-only") {
      options.committedOnly = true;
      continue;
    }
    if (argument === "--print-mirror-paths") {
      options.printMirrorPaths = true;
      continue;
    }
    if (argument === "--gate") {
      options.gate = true;
      continue;
    }
    if (argument === "--write-allowlist") {
      options.writeAllowlist = true;
      continue;
    }
    if (argument === "--check-host-file") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) {
        throw new Error("--check-host-file requires a path");
      }
      options.hostFile = value;
      continue;
    }
    if (argument.startsWith("--scope=")) {
      options.scope = argument.slice("--scope=".length);
      continue;
    }
    if (argument === "--scope") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) {
        throw new Error("--scope requires --scope=<runtime|host|deploy|all>");
      }
      options.scope = value;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  if (!["all", "runtime", "host", "deploy"].includes(options.scope)) {
    throw new Error(`Unknown --scope: ${options.scope}`);
  }
  if (options.committedOnly) {
    const exclusive = [
      ["--print-mirror-paths", options.printMirrorPaths],
      ["--check-host-file", options.hostFile !== null],
      ["--write-allowlist", options.writeAllowlist],
    ].find(([, given]) => given);
    if (exclusive !== undefined) {
      throw new Error(`--committed-only narrows --check and does not combine with ${exclusive[0]}`);
    }
    if (!options.checkOnly) {
      throw new Error("--committed-only narrows --check and does not apply to generation");
    }
  }
  return options;
}

function readRepo(path) {
  return readFileSync(join(repoRoot, path), "utf8");
}

function writeRepo(path, contents) {
  const absolute = join(repoRoot, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
}

function presentInRepo(path) {
  return existsSync(join(repoRoot, path));
}

function ownerAbsentSkip(subject, owner) {
  return `${subject}: skipped, its owner ${owner} is absent from this tree`;
}

function shellIdent(name) {
  return `DOCSFAB_LIMIT_${name
    .replaceAll(".", "_")
    .replaceAll(/([a-z\d])([A-Z])/gu, "$1_$2")
    .toUpperCase()}`;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Load the operational-limits catalog: the root registry at config/limits.yaml
 * and the per-owner fragments it lists under config/limits/, composed in
 * registry order (never directory-listing order, which differs between APFS
 * and ext4 and would make the mirrors flap between hosts).
 *
 * @param {{ repoRoot?: string, parseYaml?: (text: string, source: string) => unknown }} [options]
 *   `repoRoot` defaults to this checkout; `parseYaml` defaults to the npm
 *   `yaml` package, or the dependency-free subset parser before `npm ci`.
 */
export function loadLimitDefinitions(options = {}) {
  if (!isPlainObject(options)) {
    // A caller passing catalog text (an older signature) must not have it
    // silently ignored.
    throw new TypeError(
      "loadLimitDefinitions takes an options object ({ repoRoot, parseYaml }); the catalog is read from config/limits.yaml and its fragments",
    );
  }
  const root = options.repoRoot ?? repoRoot;
  const npmParse = options.parseYaml ? null : loadYamlParse();
  const parseYaml =
    options.parseYaml ?? (npmParse ? (text) => npmParse(text) : parseLimitsYamlSubset);
  const read = (path) => readFileSync(join(root, path), "utf8");
  const parsed = parseCatalogDocument(parseYaml, read(YAML_PATH), YAML_PATH);
  if (!isPlainObject(parsed) || parsed.schemaVersion !== 1 || parsed.kind !== "docsfab-limits") {
    throw new Error("config/limits.yaml must declare schemaVersion 1 and kind docsfab-limits");
  }
  if (Object.hasOwn(parsed, "limits")) {
    throw new Error(
      `${YAML_PATH} must not declare a limits list; each limit lives in its owner's fragment under ${FRAGMENT_DIR}/`,
    );
  }
  const fragments = parseFragmentRegistry(parsed.fragments);
  assertFragmentDirectoryMatchesRegistry(root, fragments);
  const entries = [];
  for (const fragment of fragments) {
    const path = `${FRAGMENT_DIR}/${fragment.file}`;
    const document = parseCatalogDocument(parseYaml, read(path), path);
    if (!isPlainObject(document)) {
      throw new Error(`${path} must declare a non-empty limits list`);
    }
    const extra = Object.keys(document).filter((key) => key !== "limits");
    if (extra.length > 0) {
      throw new Error(`${path} may declare only a limits list; found ${extra.join(", ")}`);
    }
    if (!Array.isArray(document.limits) || document.limits.length === 0) {
      throw new Error(`${path} must declare a non-empty limits list`);
    }
    for (const entry of document.limits) {
      entries.push({ definition: parseDefinition(entry, path), path, owner: fragment.owner });
    }
  }
  // Duplicates are checked before ownership so a copied limit is reported as a
  // duplicate naming both files.
  const seen = new Map();
  for (const { definition, path } of entries) {
    const first = seen.get(definition.name);
    if (first !== undefined) {
      throw new Error(
        `${YAML_PATH} repeats limit ${definition.name} (first in ${first}, again in ${path})`,
      );
    }
    seen.set(definition.name, path);
  }
  for (const { definition, path, owner } of entries) {
    // Exact first-segment match: `hostInvoker.x` is not owned by `host`, and
    // `host.slack.x` is.
    const prefix = definition.name.split(".")[0];
    if (prefix !== owner) {
      throw new Error(
        `${path} holds limit ${definition.name}, whose owner prefix ${prefix} is not the fragment owner ${owner}`,
      );
    }
  }
  assertRemediationCitations(entries, fragments);
  const definitions = entries.map(({ definition }) => definition);
  assertCatalogDiskHeadroomOrder(definitions);
  assertCatalogSecretsLockOrder(definitions);
  return definitions;
}

/**
 * Parse one catalog document so every syntax refusal names it, whichever
 * parser is in use. The file is read before this call, so an I/O error is not
 * relabelled; a message already naming `path` is not prefixed twice.
 */
function parseCatalogDocument(parseYaml, text, path) {
  try {
    return parseYaml(text, path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith(`${path}: `)) throw error;
    throw new Error(`${path}: ${message}`, { cause: error });
  }
}

// A `config/limits.yaml` or `config/limits/<file>` path in remediation text.
// Not a path embedded in a longer one (`/etc/x/config/...`), not
// `config/limits.catalog.json`, and never the sentence-final period.
const REMEDIATION_CITATION_RE =
  /(?<![\w./-])config\/limits(?:\.yaml|\/([A-Za-z0-9_-]+\.ya?ml))(?![\w/-]|\.\w)/giu;
// A dotted name standing alone in prose (`ci.liveModel.jobTimeoutMs`), not the
// tail of a path (`config/limits/ci.yaml`, `sast-baseline.md`).
const LIMIT_NAME_TOKEN_RE = /(?<![\w./-])[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+(?![\w/-])/gu;
// A sentence ends at . ! or ? followed by whitespace or the end of the text.
const SENTENCE_END_RE = /[.!?](?=\s|$)/gu;

function sentenceBounds(text, start, end) {
  let from = 0;
  let to = text.length;
  SENTENCE_END_RE.lastIndex = 0;
  for (let match = SENTENCE_END_RE.exec(text); match; match = SENTENCE_END_RE.exec(text)) {
    if (match.index < start) from = match.index + 1;
    else if (match.index >= end) {
      to = match.index;
      break;
    }
  }
  return { from, to };
}

/**
 * Every config/limits path the catalog's remediation text cites, with the
 * limit each citation refers to. Resolution uses catalog names only, in
 * order: (1) the nearest catalogued name before the citation in its sentence
 * (`before`); (2) else the first catalogued name after it (`after`); (3) else,
 * when the sentence names no other limit-shaped `<owner>.<name>`, the entry
 * holding the text (`self`, "raise this limit"). A sentence that names only an
 * uncatalogued `<owner>.<name>` leaves `limit` null and `unresolved` set.
 *
 * @param {readonly { name: string, remediation: string }[]} definitions
 * @param {readonly string[]} registeredFiles fragment file names in config/limits/
 */
export function remediationCitations(definitions, registeredFiles) {
  const catalogued = new Set(definitions.map(({ name }) => name));
  const owners = new Set(registeredFiles.map((file) => file.replace(/\.ya?ml$/iu, "")));
  const citations = [];
  for (const { name, remediation } of definitions) {
    REMEDIATION_CITATION_RE.lastIndex = 0;
    for (
      let match = REMEDIATION_CITATION_RE.exec(remediation);
      match;
      match = REMEDIATION_CITATION_RE.exec(remediation)
    ) {
      const start = match.index;
      const end = start + match[0].length;
      const { from, to } = sentenceBounds(remediation, start, end);
      const tokens = [...remediation.slice(from, to).matchAll(LIMIT_NAME_TOKEN_RE)].map(
        (token) => ({ text: token[0], start: from + token.index }),
      );
      const known = tokens.filter(({ text }) => catalogued.has(text));
      const before = known.filter((token) => token.start + token.text.length <= start).at(-1);
      const after = known.find((token) => token.start >= end);
      const unknown = tokens.find(
        ({ text }) => !catalogued.has(text) && owners.has(text.split(".")[0]),
      );
      let limit = null;
      let rule = null;
      if (before) [limit, rule] = [before.text, "before"];
      else if (after) [limit, rule] = [after.text, "after"];
      else if (!unknown) [limit, rule] = [name, "self"];
      citations.push({
        entry: name,
        cited: match[0],
        file: match[1] ?? null,
        limit,
        rule,
        unresolved: limit === null ? unknown.text : null,
      });
    }
  }
  return citations;
}

/**
 * Refuse, by fragment path and limit name, a remediation citation that does
 * not name the fragment owning the limit it refers to: a leftover root
 * config/limits.yaml citation, an unregistered fragment, a citation with no
 * resolvable limit, or the wrong owner. A citation of a different fragment
 * than the one holding the text is correct when it names that fragment's
 * limit (localWorkflows.canaryJobReserveMs cites ci.liveModel.jobTimeoutMs).
 */
function assertRemediationCitations(entries, fragments) {
  const registered = new Set(fragments.map(({ file }) => file));
  const pathByName = new Map(entries.map(({ definition, path }) => [definition.name, path]));
  const citations = remediationCitations(
    entries.map(({ definition }) => definition),
    fragments.map(({ file }) => file),
  );
  for (const { entry, cited, file, limit, unresolved } of citations) {
    const at = `${pathByName.get(entry)}: remediation of ${entry} cites ${cited}`;
    const owning = limit === null ? null : `${FRAGMENT_DIR}/${limit.split(".")[0]}.yaml`;
    if (file === null) {
      throw new Error(
        owning === null
          ? `${at}, the fragment registry; cite the fragment that owns the limit it names`
          : `${at}, the fragment registry; cite ${owning}, the fragment that owns ${limit}`,
      );
    }
    if (!registered.has(file)) {
      throw new Error(`${at}, which ${YAML_PATH} does not register`);
    }
    if (limit === null) {
      throw new Error(
        `${at} for ${unresolved}, which is not a catalogued limit; name a limit from the catalog`,
      );
    }
    if (cited !== owning) {
      throw new Error(`${at} for ${limit}, whose owning fragment is ${owning}`);
    }
  }
}

function parseFragmentRegistry(registry) {
  if (!Array.isArray(registry) || registry.length === 0) {
    throw new Error(`${YAML_PATH} must declare a non-empty fragments registry`);
  }
  const owners = new Set();
  return registry.map((entry) => {
    if (!isPlainObject(entry)) {
      throw new Error(`each ${YAML_PATH} fragments entry must be a mapping of file and owner`);
    }
    const owner = requiredString(entry, "owner");
    const file = requiredString(entry, "file");
    if (!FRAGMENT_OWNER_RE.test(owner)) {
      throw new Error(`${YAML_PATH} fragment owner ${owner} must be one name segment`);
    }
    if (file !== `${owner}.yaml`) {
      throw new Error(
        `${YAML_PATH} registers fragment ${file} for owner ${owner}; the file must be named ${owner}.yaml`,
      );
    }
    if (owners.has(owner)) {
      throw new Error(`${YAML_PATH} registers owner ${owner} more than once`);
    }
    owners.add(owner);
    return Object.freeze({ file, owner });
  });
}

/**
 * Refuse, by name, anything under config/limits/ the registry does not
 * account for, and any registered fragment that is absent. Presence is
 * compared against the exact directory listing, not existsSync: on a
 * case-insensitive filesystem (APFS) existsSync("host.yaml") is true for a
 * file named Host.yaml, which Linux CI would then fail to find.
 */
function assertFragmentDirectoryMatchesRegistry(root, fragments) {
  const directory = join(root, FRAGMENT_DIR);
  if (!existsSync(directory)) {
    throw new Error(`${FRAGMENT_DIR}/ is missing; ${YAML_PATH} registers its fragments there`);
  }
  const names = readdirSync(directory).sort();
  const registered = new Set(fragments.map(({ file }) => file));
  const byLowerCase = new Map(fragments.map(({ file }) => [file.toLowerCase(), file]));
  for (const name of names) {
    const entry = join(directory, name);
    // A symlink is judged by its target, so a linked directory is refused as one.
    let stats = lstatSync(entry);
    if (stats.isSymbolicLink()) {
      try {
        stats = statSync(entry);
      } catch (error) {
        // Handles exactly a dangling link (ENOENT on its target); a link loop
        // (ELOOP) or a permission error propagates.
        if (error?.code !== "ENOENT") throw error;
        if (!FRAGMENT_FILE_RE.test(name)) continue;
        throw new Error(
          `${FRAGMENT_DIR}/${name} is a symlink whose target does not exist; restore the target or remove the link`,
          { cause: error },
        );
      }
    }
    if (stats.isDirectory()) {
      throw new Error(
        `${FRAGMENT_DIR}/${name} is a directory; limit fragments are flat files registered in ${YAML_PATH}`,
      );
    }
    // Only a *.yaml / *.yml name (any case) can be mistaken for a fragment.
    if (!FRAGMENT_FILE_RE.test(name) || registered.has(name)) continue;
    const caseTwin = byLowerCase.get(name.toLowerCase());
    if (caseTwin !== undefined) {
      throw new Error(
        `${FRAGMENT_DIR}/${name} differs only in case from the registered fragment ${caseTwin}; rename it to match ${YAML_PATH} exactly`,
      );
    }
    throw new Error(
      `${FRAGMENT_DIR}/${name} is not registered in ${YAML_PATH}; add it to the fragments registry or remove it`,
    );
  }
  const present = new Set(names);
  for (const { file } of fragments) {
    if (!present.has(file)) {
      throw new Error(
        `registered fragment ${FRAGMENT_DIR}/${file} is missing; restore it or remove it from ${YAML_PATH}`,
      );
    }
  }
}

function assertCatalogDiskHeadroomOrder(definitions) {
  const over = definitions.find((entry) => entry.name === "deploy.diskHeadroomOverBytes");
  const warn = definitions.find((entry) => entry.name === "deploy.diskHeadroomWarnBytes");
  if (!over || !warn) {
    throw new Error(
      "config/limits.yaml must declare deploy.diskHeadroomOverBytes and deploy.diskHeadroomWarnBytes",
    );
  }
  if (!(warn.value > over.value)) {
    throw new Error(
      `deploy.diskHeadroomWarnBytes ${warn.value} must exceed deploy.diskHeadroomOverBytes ${over.value}`,
    );
  }
  assertDiskHeadroomOrder(definitions, [
    { name: over.name, value: over.value },
    { name: warn.name, value: warn.value },
  ]);
}

function assertCatalogSecretsLockOrder(definitions) {
  const wait = definitions.find((entry) => entry.name === "secrets.lockWaitMs");
  const stale = definitions.find((entry) => entry.name === "secrets.lockStaleMs");
  const retry = definitions.find((entry) => entry.name === "secrets.lockRetryMs");
  if (!wait || !stale || !retry) {
    throw new Error(
      "config/limits.yaml must declare secrets.lockWaitMs, secrets.lockStaleMs, and secrets.lockRetryMs",
    );
  }
  if (!(stale.value < wait.value)) {
    throw new Error(
      `secrets.lockStaleMs ${stale.value} must stay below secrets.lockWaitMs ${wait.value}`,
    );
  }
  assertSecretsLockOrder(definitions, [
    { name: wait.name, value: wait.value },
    { name: stale.name, value: stale.value },
    { name: retry.name, value: retry.value },
  ]);
}

function parseDefinition(entry, source) {
  // Every refusal names the fragment holding the entry.
  const refuse = (message) => new Error(`${source}: ${message}`);
  if (!isPlainObject(entry)) throw refuse("each limits.yaml entry must be a mapping");
  const name = requiredString(entry, "name", refuse);
  const unit = requiredString(entry, "unit", refuse);
  const scope = requiredString(entry, "scope", refuse);
  if (!SCOPES.has(scope))
    throw refuse(`${name}: scope must be per-run, per-host, per-project, or sealed`);
  const refusal = requiredString(entry, "refusal", refuse);
  const remediation = requiredString(entry, "remediation", refuse);
  const rationale = requiredString(entry, "rationale", refuse);
  const value = requiredFinite(entry, "value", name, refuse);
  const warnAt = requiredFinite(entry, "warnAt", name, refuse);
  const min = requiredFinite(entry, "min", name, refuse);
  const max = requiredFinite(entry, "max", name, refuse);
  if (!(min <= value && value <= max)) {
    throw refuse(`${name}: value ${value} is outside [${min}, ${max}]`);
  }
  if (!(warnAt > 0 && warnAt <= 1)) {
    throw refuse(`${name}: warnAt must be in (0, 1]`);
  }
  const override =
    entry.override == null || entry.override === "none" ? null : String(entry.override);
  if (override !== null && !/^DOCSFAB_[A-Z0-9_]+$/u.test(override)) {
    throw refuse(`${name}: override must be a DOCSFAB_* env name or null`);
  }
  if (scope === "sealed" && override !== null) {
    throw refuse(`${name}: sealed limits reject every override tier`);
  }
  // Optional docs-facing fields, distinct from the implementation-facing
  // `rationale`. Only entries the generated doc tables render need them; the
  // generator names a missing one rather than rendering a blank cell.
  const docValue = optionalString(entry, "docValue", name, refuse);
  const docSummary = optionalString(entry, "docSummary", name, refuse);
  // `docValueCode: code` renders `value` as inline code, since a YAML plain
  // scalar cannot start with a backtick. The string "code", not boolean `true`:
  // the subset parser has no booleans, so `true` would parse differently there.
  const docValueCodeRaw = optionalString(entry, "docValueCode", name, refuse);
  if (docValueCodeRaw !== null && docValueCodeRaw !== "code") {
    throw refuse(`${name}: docValueCode must be exactly "code" when present`);
  }
  const docValueCode = docValueCodeRaw === "code";
  if (docValueCode && docValue !== null) {
    throw refuse(`${name}: docValueCode and docValue are mutually exclusive`);
  }
  // `docValue` is hand-kept prose, so its leading number (thousands-separated
  // or not) must equal `value`. The rest of the prose ("(5 minutes)") is
  // unchecked.
  if (docValue !== null) {
    const leading = /^(-?[\d,]+(?:\.\d+)?)(?=\s|$)/u.exec(docValue);
    if (!leading) {
      throw refuse(
        `${name}: docValue "${docValue}" must start with the numeric default (matching value)`,
      );
    }
    const leadingNumber = Number(leading[1].replace(/,/gu, ""));
    if (!Number.isFinite(leadingNumber) || leadingNumber !== value) {
      throw refuse(
        `${name}: docValue "${docValue}" starts with ${leading[1]}, but value is ${value}; ` +
          `update docValue's leading number to match value (or regenerate after changing value)`,
      );
    }
  }
  return Object.freeze({
    name,
    value,
    unit,
    scope,
    warnAt,
    override,
    min,
    max,
    refusal,
    remediation,
    rationale,
    ...(docValue !== null ? { docValue } : {}),
    ...(docValueCode ? { docValueCode } : {}),
    ...(docSummary !== null ? { docSummary } : {}),
  });
}

const plainError = (message) => new Error(message);

function requiredString(entry, key, refuse = plainError) {
  const value = entry[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw refuse(`limits.yaml entry missing ${key}`);
  }
  return value.trim();
}

function optionalString(entry, key, name, refuse) {
  if (!Object.hasOwn(entry, key) || entry[key] == null) return null;
  if (typeof entry[key] !== "string" || entry[key].trim().length === 0) {
    throw refuse(`${name}: ${key} must be a non-empty string when present`);
  }
  return entry[key].trim();
}

function requiredFinite(entry, key, name, refuse) {
  const value = entry[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw refuse(`${name}: ${key} must be a finite number`);
  }
  return value;
}

function tsString(value) {
  return JSON.stringify(value);
}

function tsField(name, rendered) {
  const inline = `    ${name}: ${rendered},`;
  if (inline.length <= TS_LINE_WIDTH) return inline;
  return `    ${name}:\n      ${rendered},`;
}

export function renderTypeScript(definitions) {
  const records = definitions
    .map((definition) => {
      const fields = [
        tsField("name", tsString(definition.name)),
        tsField("value", String(definition.value)),
        tsField("unit", tsString(definition.unit)),
        tsField("scope", tsString(definition.scope)),
        tsField("warnAt", String(definition.warnAt)),
        tsField("override", definition.override === null ? "null" : tsString(definition.override)),
        tsField("min", String(definition.min)),
        tsField("max", String(definition.max)),
        tsField("refusal", tsString(definition.refusal)),
        tsField("remediation", tsString(definition.remediation)),
        tsField("rationale", tsString(definition.rationale)),
      ].join("\n");
      return `  {\n${fields}\n  }`;
    })
    .join(",\n");
  return `// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Generated by packages/runtime/scripts/check-limits.mjs. Do not hand-edit.
 */
export type LimitScope = "per-run" | "per-host" | "per-project" | "sealed";

export interface LimitDefinition {
  readonly name: string;
  readonly value: number;
  readonly unit: string;
  readonly scope: LimitScope;
  readonly warnAt: number;
  readonly override: string | null;
  readonly min: number;
  readonly max: number;
  readonly refusal: string;
  readonly remediation: string;
  readonly rationale: string;
}

export const LIMIT_DEFINITIONS: readonly LimitDefinition[] = Object.freeze([
${records},
]);

export const LIMIT_DEFINITION_BY_NAME: Readonly<Record<string, LimitDefinition>> = Object.freeze(
  Object.fromEntries(LIMIT_DEFINITIONS.map((definition) => [definition.name, definition])),
);
`;
}

/**
 * The knowledge first pass's mirror: each `firstPass.*` catalog default, keyed
 * by the name after `firstPass.`. Knowledge reads its defaults here instead of
 * declaring literals; the runtime host passes the override-resolved values.
 */
export function renderKnowledgeFirstPassLimits(definitions) {
  const entries = definitions.filter((definition) =>
    definition.name.startsWith(FIRST_PASS_LIMIT_PREFIX),
  );
  if (entries.length === 0) {
    throw new Error(`config/limits.yaml must declare ${FIRST_PASS_LIMIT_PREFIX}* limits`);
  }
  const fields = entries
    .map((definition) => {
      const key = definition.name.slice(FIRST_PASS_LIMIT_PREFIX.length);
      if (!/^[A-Za-z][A-Za-z0-9]*$/u.test(key)) {
        throw new Error(`${definition.name}: a firstPass limit name must be one identifier`);
      }
      return `  ${key}: ${String(definition.value)},`;
    })
    .join("\n");
  return `// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Generated by packages/runtime/scripts/check-limits.mjs from
 * config/limits/firstPass.yaml. Do not hand-edit; change the fragment and run
 * \`npm run generate:limits\` from packages/runtime.
 *
 * Catalog defaults of the \`firstPass.*\` operational limits, keyed by the name
 * after \`firstPass.\`. The runtime host resolves host overrides and passes the
 * effective values to the first pass; a caller without a host uses these.
 */
export const FIRST_PASS_LIMIT_DEFAULTS = Object.freeze({
${fields}
});
`;
}

/** The shell mirror for the deploy root, which sources it from `deployRoot`. */
export function renderShell(definitions, deployRoot) {
  const rows = definitions
    .map(
      (definition) =>
        `${definition.name}|${definition.value}|${definition.unit}|${definition.warnAt}|${definition.scope}|config/limits.yaml`,
    )
    .join("\n");
  const constants = definitions
    .map((definition) => {
      const ident = shellIdent(definition.name);
      return [
        `readonly ${ident}=${definition.value}`,
        `readonly ${ident}_UNIT=${shellQuote(definition.unit)}`,
        `readonly ${ident}_WARN_AT=${definition.warnAt}`,
        `readonly ${ident}_SCOPE=${shellQuote(definition.scope)}`,
      ].join("\n");
    })
    .join("\n");
  return `#!/usr/bin/env bash
# Generated by packages/runtime/scripts/check-limits.mjs. Do not hand-edit.
# Sourced by ${deployRoot}/lib.sh and service-status.sh.
if [[ "\${DOCSFAB_LIMITS_GENERATED_LOADED:-}" == "1" ]]; then
  return 0
fi
DOCSFAB_LIMITS_GENERATED_LOADED=1
${constants}

docsfab_limits_rows() {
  cat <<'DOCSFAB_LIMITS_TSV'
${rows}
DOCSFAB_LIMITS_TSV
}
`;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function renderRecoveryJson(definitions) {
  const recovery = {};
  for (const definition of definitions) {
    if (!definition.name.startsWith("recovery.")) continue;
    recovery[definition.name.slice("recovery.".length)] = definition.value;
  }
  const required = [
    "logicalObjectMaxBytes",
    "legacyLogicalObjectMaxBytes",
    "minimumLogicalObjectMaxBytes",
    "manifestMaxBytes",
    "logicalCiphertextOverheadBytes",
    "headroomWarnRatio",
    "headroomDegradedRatio",
  ];
  for (const key of required) {
    if (typeof recovery[key] !== "number") {
      throw new Error(`config/limits.yaml is missing recovery.${key}`);
    }
  }
  const ordered = Object.fromEntries(required.map((key) => [key, recovery[key]]));
  return `${JSON.stringify({ schemaVersion: 1, kind: "docsfab-limits", recovery: ordered }, null, 2)}\n`;
}

/**
 * Full-catalog JSON mirror keyed by name, so a new catalog entry appears with
 * no code change. For non-JS/TS consumers that cannot import the TypeScript
 * mirrors and must not re-implement the YAML subset parser.
 */
export function renderCatalogJson(definitions) {
  const limits = {};
  for (const definition of definitions) {
    limits[definition.name] = {
      value: definition.value,
      unit: definition.unit,
      scope: definition.scope,
      warnAt: definition.warnAt,
      override: definition.override,
      min: definition.min,
      max: definition.max,
      refusal: definition.refusal,
      remediation: definition.remediation,
      rationale: definition.rationale,
      // Present only for entries that declare them.
      ...(definition.docValue !== undefined ? { docValue: definition.docValue } : {}),
      ...(definition.docValueCode !== undefined ? { docValueCode: definition.docValueCode } : {}),
      ...(definition.docSummary !== undefined ? { docSummary: definition.docSummary } : {}),
    };
  }
  return `${JSON.stringify({ schemaVersion: 1, kind: "docsfab-limits-catalog", limits }, null, 2)}\n`;
}

export function gitlabDurationFromMs(ms) {
  if (!Number.isInteger(ms) || ms <= 0) {
    throw new Error(`GitLab duration requires a positive integer millisecond value, got ${ms}`);
  }
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  throw new Error(`${LIVE_MODEL_JOB_TIMEOUT_LIMIT} ${ms} cannot be projected as a GitLab duration`);
}

export function gitlabExpireInFromDays(days) {
  if (!Number.isInteger(days) || days <= 0) {
    throw new Error(`GitLab expire_in requires a positive integer day value, got ${days}`);
  }
  return `${days} days`;
}

function requiredLimit(definitions, name, unit) {
  const definition = definitions.find((entry) => entry.name === name);
  if (!definition || definition.unit !== unit) {
    throw new Error(`config/limits.yaml must declare ${name} with unit ${unit}`);
  }
  return definition;
}

export function renderGitlabLiveModelLimits(definitions) {
  const timeout = requiredLimit(definitions, LIVE_MODEL_JOB_TIMEOUT_LIMIT, "ms");
  const acceptanceTimeout = requiredLimit(
    definitions,
    LIVE_MODEL_ACCEPTANCE_JOB_TIMEOUT_LIMIT,
    "ms",
  );
  const journeyTimeout = requiredLimit(definitions, LIVE_JOURNEY_JOB_TIMEOUT_LIMIT, "ms");
  const retention = requiredLimit(definitions, LIVE_MODEL_EVIDENCE_RETENTION_LIMIT, "days");
  return `# Generated by packages/runtime/scripts/check-limits.mjs. Do not hand-edit.
# Platform projection of ${LIVE_MODEL_JOB_TIMEOUT_LIMIT},
# ${LIVE_MODEL_ACCEPTANCE_JOB_TIMEOUT_LIMIT},
# ${LIVE_JOURNEY_JOB_TIMEOUT_LIMIT} and
# ${LIVE_MODEL_EVIDENCE_RETENTION_LIMIT}. GitLab job timeout and artifact
# expiry cannot call limit(); this include is the generated mirror.
.ci_live_model_platform_bounds:
  timeout: ${gitlabDurationFromMs(timeout.value)}
  artifacts:
    expire_in: ${gitlabExpireInFromDays(retention.value)}
.ci_live_model_acceptance_platform_bounds:
  timeout: ${gitlabDurationFromMs(acceptanceTimeout.value)}
  artifacts:
    expire_in: ${gitlabExpireInFromDays(retention.value)}
.ci_live_journey_platform_bounds:
  timeout: ${gitlabDurationFromMs(journeyTimeout.value)}
  artifacts:
    expire_in: ${gitlabExpireInFromDays(retention.value)}
`;
}

export function renderGitlabWsl2Limits(definitions) {
  const timeout = requiredLimit(definitions, WSL2_JOB_TIMEOUT_LIMIT, "ms");
  const retries = requiredLimit(definitions, WSL2_AUTOMATIC_RETRIES_LIMIT, "count");
  return `# Generated by packages/runtime/scripts/check-limits.mjs. Do not hand-edit.
# Platform projection of ${WSL2_JOB_TIMEOUT_LIMIT} and
# ${WSL2_AUTOMATIC_RETRIES_LIMIT}. GitLab cannot call limit().
.ci_wsl2_platform_bounds:
  timeout: ${gitlabDurationFromMs(timeout.value)}
.ci_wsl2_no_auto_retry:
  retry: ${retries.value}
`;
}

export function renderGitlabNightlyLimits(definitions) {
  const timeout = requiredLimit(definitions, NIGHTLY_JOB_TIMEOUT_LIMIT, "ms");
  const script = requiredLimit(definitions, NIGHTLY_SCRIPT_TIMEOUT_LIMIT, "ms");
  const retries = requiredLimit(definitions, NIGHTLY_CI_ARM_RETRIES_LIMIT, "count");
  if (script.value >= timeout.value)
    throw new Error(
      "nightly-ci-script-timeout: script must leave time for after_script and artifacts",
    );
  return `# Generated by packages/runtime/scripts/check-limits.mjs. Do not hand-edit.
# Platform projection of ${NIGHTLY_JOB_TIMEOUT_LIMIT}, ${NIGHTLY_SCRIPT_TIMEOUT_LIMIT} and
# ${NIGHTLY_CI_ARM_RETRIES_LIMIT}. GitLab timeout/retry cannot call limit(),
# so the nightly jobs extend these generated mirrors.
.ci_nightly_platform_bounds:
  timeout: ${gitlabDurationFromMs(timeout.value)}
.ci_nightly_arm_script_bounds:
  variables:
    RUNNER_SCRIPT_TIMEOUT: ${gitlabDurationFromMs(script.value)}
.ci_nightly_no_auto_retry:
  retry: ${retries.value}
`;
}

export function renderGitlabArtifactRetentionLimits(definitions) {
  const handoff = requiredLimit(definitions, ARTIFACT_HANDOFF_RETENTION_LIMIT, "days");
  const report = requiredLimit(definitions, ARTIFACT_REPORT_RETENTION_LIMIT, "days");
  return `# Generated by packages/runtime/scripts/check-limits.mjs. Do not hand-edit.
# Platform projection of ${ARTIFACT_HANDOFF_RETENTION_LIMIT} and
# ${ARTIFACT_REPORT_RETENTION_LIMIT}. GitLab artifact expiry cannot call
# limit(); this include is the generated mirror.
.ci_handoff_artifacts:
  artifacts:
    expire_in: ${gitlabExpireInFromDays(handoff.value)}
.ci_report_artifacts:
  artifacts:
    expire_in: ${gitlabExpireInFromDays(report.value)}
`;
}

export function renderGitlabSastLimits(definitions) {
  const timeout = requiredLimit(definitions, SAST_SEMGREP_TIMEOUT_LIMIT, "s");
  const maxTargetBytes = requiredLimit(definitions, SAST_MAX_TARGET_BYTES_LIMIT, "bytes");
  return `# Generated by packages/runtime/scripts/check-limits.mjs. Do not hand-edit.
# Platform projection of ${SAST_SEMGREP_TIMEOUT_LIMIT} and
# ${SAST_MAX_TARGET_BYTES_LIMIT}. The semgrep-sast job's
# SAST_SCANNER_ALLOWED_CLI_OPTS cannot call limit(); this include adds
# ${SAST_SEMGREP_TIMEOUT_VARIABLE} and ${SAST_MAX_TARGET_BYTES_VARIABLE} to
# the job's variables (deep-merged alongside .gitlab/ci/blueprint-compliance.yml's
# own override, not extends:, which would replace the template's job
# inheritance instead of adding to it).
semgrep-sast:
  variables:
    ${SAST_SEMGREP_TIMEOUT_VARIABLE}: "${timeout.value}"
    ${SAST_MAX_TARGET_BYTES_VARIABLE}: "${maxTargetBytes.value}"
`;
}

export function extractGitlabJob(yaml, jobId) {
  const lines = yaml.split("\n");
  const header = `${jobId}:`;
  const start = lines.indexOf(header);
  if (start < 0) {
    throw new Error(`GitLab YAML is missing job ${jobId}`);
  }
  if (lines.indexOf(header, start + 1) >= 0) {
    // GitLab keeps only the last of a repeated top-level key, so reading the
    // first would check a job body GitLab never runs. Refuse instead.
    throw new Error(`GitLab YAML has more than one top-level "${header}" mapping key`);
  }
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index] !== "" && !lines[index].startsWith(" ") && !lines[index].startsWith("\t")) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/**
 * Each real-model job must extend the generated bounds anchor for its own
 * catalog entry and declare no literal of its own; the acceptance run and the
 * journey gate must not inherit the shared live-model ceiling.
 */
export function verifyGitlabLiveModelProjection(runtimeYaml) {
  const failures = [];
  const anchors = [
    ".ci_live_model_platform_bounds",
    ".ci_live_model_acceptance_platform_bounds",
    ".ci_live_journey_platform_bounds",
  ];
  const extendsAnchor = (job, anchor) =>
    new RegExp(`^\\s+-\\s+${anchor.replace(/[.]/gu, "\\.")}\\s*$`, "mu").test(job);
  for (const [jobId, anchor] of [
    ["runtime:live-model", ".ci_live_model_acceptance_platform_bounds"],
    ["runtime:live-journey", ".ci_live_journey_platform_bounds"],
  ]) {
    const job = extractGitlabJob(runtimeYaml, jobId);
    if (!extendsAnchor(job, anchor)) {
      failures.push(
        `runtime.yml ${jobId} must extend ${anchor} from the generated CI limits include`,
      );
    }
    for (const other of anchors.filter((candidate) => candidate !== anchor)) {
      if (extendsAnchor(job, other)) {
        failures.push(
          `runtime.yml ${jobId} must not also extend ${other}; GitLab applies the last of several bounds`,
        );
      }
    }
    if (/^\s+timeout:/mu.test(job)) {
      failures.push(
        `runtime.yml ${jobId} must not declare timeout:; use the generated platform bounds`,
      );
    }
    if (/expire_in:/u.test(job)) {
      failures.push(
        `runtime.yml ${jobId} must not declare expire_in:; use the generated platform bounds`,
      );
    }
  }
  return failures;
}

export function verifyGitlabWsl2Projection(runtimeYaml) {
  const job = extractGitlabJob(runtimeYaml, "runtime:wsl2:installed");
  const failures = [];
  if (!job.includes("- .ci_wsl2_platform_bounds")) {
    failures.push("runtime.yml runtime:wsl2:installed must extend .ci_wsl2_platform_bounds");
  }
  if (!job.includes("- .ci_wsl2_no_auto_retry")) {
    failures.push("runtime.yml runtime:wsl2:installed must extend .ci_wsl2_no_auto_retry");
  }
  if (/^\s+timeout:/mu.test(job)) {
    failures.push("runtime.yml runtime:wsl2:installed must use the generated timeout");
  }
  if (/^\s+retry:/mu.test(job)) {
    failures.push("runtime.yml runtime:wsl2:installed must use the generated retry policy");
  }
  return failures;
}

/**
 * Each listed job must take its artifact expiry from the generated retention
 * include, and no job in these files may declare an expire_in: literal.
 * Real-model jobs extend the live-model bounds and are checked there. Checks
 * the files it is given, so a tree without one of them can skip it by owner.
 */
export function verifyGitlabArtifactRetentionProjection(ciYamlByPath) {
  const failures = [];
  for (const [path, yaml] of Object.entries(ciYamlByPath)) {
    const jobs = GITLAB_ARTIFACT_RETENTION_JOBS[path];
    if (jobs === undefined) {
      throw new Error(`${path} is not a file the artifact retention projection governs`);
    }
    for (const [jobId, anchor] of jobs) {
      const job = extractGitlabJob(yaml, jobId);
      const escapedAnchor = anchor.replace(/[.]/gu, "\\.");
      if (!new RegExp(`^\\s+(?:extends:|-)\\s+${escapedAnchor}\\s*$`, "mu").test(job)) {
        failures.push(
          `${path} ${jobId} must extend ${anchor} from the generated artifact retention include`,
        );
      }
    }
    for (const [index, line] of yaml.split("\n").entries()) {
      if (/^\s+expire_in:/u.test(line)) {
        failures.push(
          `${path}:${index + 1} must not declare expire_in:; extend a generated retention include instead`,
        );
      }
    }
  }
  return failures;
}

/**
 * Guards blueprint-compliance.yml's semgrep-sast override, which lies outside
 * the product scan roots, against silently escaping the SAST catalog bounds. It
 * refuses:
 *   - a missing override or a hand-declared `--timeout`/`--max-target-bytes`
 *     literal in SAST_SCANNER_ALLOWED_CLI_OPTS;
 *   - a hand-declared SEMGREP_RULE_TIMEOUT_SECONDS or SEMGREP_MAX_TARGET_BYTES
 *     in the job's own `variables:`, which would shadow the generated value.
 *     A project- or group-level CI/CD UI variable of either name has higher
 *     precedence than any YAML value and is outside repo-checkable scope;
 *   - a non-empty SAST_EXCLUDED_PATHS, which would reintroduce the test-path
 *     exclusions governance/security/sast-baseline.md requires stay removed.
 */
export function verifyGitlabSastProjection(blueprintYaml, definitions) {
  const timeout = requiredLimit(definitions, SAST_SEMGREP_TIMEOUT_LIMIT, "s");
  const maxTargetBytes = requiredLimit(definitions, SAST_MAX_TARGET_BYTES_LIMIT, "bytes");
  const failures = [];
  const job = extractGitlabJob(blueprintYaml, "semgrep-sast");
  const expected = `--timeout $${SAST_SEMGREP_TIMEOUT_VARIABLE} --max-target-bytes $${SAST_MAX_TARGET_BYTES_VARIABLE}`;
  const match = /^\s+SAST_SCANNER_ALLOWED_CLI_OPTS:\s*"([^"]*)"/mu.exec(job);
  if (!match || match[1] !== expected) {
    failures.push(
      `blueprint-compliance.yml semgrep-sast must set SAST_SCANNER_ALLOWED_CLI_OPTS: "${expected}", projecting ${SAST_SEMGREP_TIMEOUT_LIMIT} (currently ${timeout.value}s) and ${SAST_MAX_TARGET_BYTES_LIMIT} (currently ${maxTargetBytes.value} bytes) from the generated .gitlab/ci/sast-limits.generated.yml include, not a hand-declared literal`,
    );
  }
  for (const variable of [SAST_SEMGREP_TIMEOUT_VARIABLE, SAST_MAX_TARGET_BYTES_VARIABLE]) {
    if (new RegExp(`^\\s+${variable}:`, "mu").test(job)) {
      failures.push(
        `blueprint-compliance.yml semgrep-sast must not hand-declare ${variable}: in its own variables: block; it shadows the value .gitlab/ci/sast-limits.generated.yml deep-merges in from config/limits.yaml`,
      );
    }
  }
  const excludedPathsMatch = /^\s+SAST_EXCLUDED_PATHS:\s*"([^"]*)"/mu.exec(job);
  if (!excludedPathsMatch || excludedPathsMatch[1] !== "") {
    failures.push(
      'blueprint-compliance.yml semgrep-sast must set SAST_EXCLUDED_PATHS: "" (empty); a non-empty value reintroduces the inherited test-path exclusions governance/security/sast-baseline.md requires stay removed',
    );
  }
  return failures;
}

/**
 * Refuses if .gitlab-ci.yml's `include:` list drops the generated SAST limits
 * mirror. CI lint stays valid without it, and the pinned Semgrep analyzer
 * skips an unparseable CLI flag instead of failing, so the scan would silently
 * fall back to its defaults.
 *
 * Matches an uncommented `- local: <path>` line, so a commented-out include
 * fails. Does not use the `yaml` package: `process:scripts` runs this with no
 * `npm ci` first.
 */
function hasActiveGitlabInclude(gitlabCiYaml, path) {
  const escapedPath = path.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const includePattern = new RegExp(`^[ \\t]*-[ \\t]*local:[ \\t]*${escapedPath}[ \\t]*$`, "mu");
  return includePattern.test(gitlabCiYaml);
}

export function verifyGitlabSastIncludePresence(gitlabCiYaml) {
  if (hasActiveGitlabInclude(gitlabCiYaml, GITLAB_SAST_LIMITS_GENERATED)) return [];
  return [
    `.gitlab-ci.yml must include an active, uncommented "- local: ${GITLAB_SAST_LIMITS_GENERATED}" line; without it the generated SAST limits mirror never reaches the pipeline`,
  ];
}

/**
 * Without the include, `extends: .ci_handoff_artifacts` fails GitLab lint, but
 * only on a pipeline; this surfaces the drop in `npm run check:limits`.
 */
export function verifyGitlabArtifactRetentionIncludePresence(gitlabCiYaml) {
  if (hasActiveGitlabInclude(gitlabCiYaml, GITLAB_ARTIFACT_RETENTION_GENERATED)) return [];
  return [
    `.gitlab-ci.yml must include an active, uncommented "- local: ${GITLAB_ARTIFACT_RETENTION_GENERATED}" line; without it the generated artifact retention mirror never reaches the pipeline`,
  ];
}

export function verifyGitlabWsl2IncludePresence(gitlabCiYaml) {
  if (hasActiveGitlabInclude(gitlabCiYaml, GITLAB_WSL2_GENERATED)) return [];
  return [`.gitlab-ci.yml must include ${GITLAB_WSL2_GENERATED} for the installed WSL2 job`];
}

/**
 * Every mirror this tool writes, keyed by repository path. The deploy shell
 * mirror is among them only when a deploy root is configured.
 */
export function renderMirrors(definitions, deployRoot = configuredDeployRoot()) {
  return {
    [RUNTIME_GENERATED]: renderTypeScript(definitions),
    [KNOWLEDGE_FIRST_PASS_GENERATED]: renderKnowledgeFirstPassLimits(definitions),
    ...(deployRoot === null
      ? {}
      : { [deployShellMirrorPath(deployRoot)]: renderShell(definitions, deployRoot) }),
    [GITLAB_LIVE_MODEL_GENERATED]: renderGitlabLiveModelLimits(definitions),
    [GITLAB_WSL2_GENERATED]: renderGitlabWsl2Limits(definitions),
    [GITLAB_NIGHTLY_GENERATED]: renderGitlabNightlyLimits(definitions),
    [GITLAB_SAST_LIMITS_GENERATED]: renderGitlabSastLimits(definitions),
    [GITLAB_ARTIFACT_RETENTION_GENERATED]: renderGitlabArtifactRetentionLimits(definitions),
    [TRAIN_REUSE_LIMITS_GENERATED]: renderTrainReuseLimits(definitions),
    [JSON_MIRROR]: renderRecoveryJson(definitions),
    [CATALOG_JSON_MIRROR]: renderCatalogJson(definitions),
  };
}

/**
 * The offline train-metadata reader's narrow canonical limits mirror. Its
 * source digests detect stale generation at reader startup; the normal limits
 * gate compares this entire rendered body byte-for-byte.
 */
export function renderTrainReuseLimits(definitions) {
  const entries = definitions.filter((definition) => definition.name.startsWith("ci.trainReuse."));
  if (entries.length !== 4) {
    throw new Error("config/limits.yaml must declare exactly four ci.trainReuse limits");
  }
  const sourceDigests = Object.fromEntries(
    TRAIN_REUSE_SOURCE_PATHS.map((path) => [
      path,
      createHash("sha256").update(readRepo(path), "utf8").digest("hex"),
    ]),
  );
  const limits = Object.fromEntries(
    entries.map((definition) => [
      definition.name,
      {
        value: definition.value,
        unit: definition.unit,
        scope: definition.scope,
        warnAt: definition.warnAt,
        override: definition.override,
        min: definition.min,
        max: definition.max,
        refusal: definition.refusal,
        remediation: definition.remediation,
      },
    ]),
  );
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      kind: "docsfab-ci-train-reuse-limits",
      sourceDigests,
      limits,
    },
    null,
    2,
  )}\n`;
}

function verifySealed(definitions) {
  const registry = JSON.parse(readRepo(REGISTRY_PATH));
  const compositions = registry.compositions;
  if (!Array.isArray(compositions) || compositions.length === 0) {
    throw new Error("composition-registry.json has no compositions");
  }
  const failures = [];
  for (const field of SEALED_FIELDS) {
    const name = `sealed.compositionLimits.${field}`;
    const definition = definitions.find((entry) => entry.name === name);
    if (!definition || definition.scope !== "sealed") {
      failures.push(`missing sealed entry ${name}`);
      continue;
    }
    const values = compositions.map((composition) => composition.compositionLimits?.[field]);
    if (values.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
      failures.push(`composition-registry compositionLimits.${field} is missing`);
      continue;
    }
    const ceiling = Math.max(...values);
    if (definition.value !== ceiling) {
      failures.push(
        `${name} value ${definition.value} disagrees with sealed composition-registry ceiling ${ceiling}`,
      );
    }
  }
  return failures;
}

function verifyBoundTests(definitions) {
  if (!existsSync(join(repoRoot, BOUNDS_TEST))) {
    return [`${BOUNDS_TEST} is missing`];
  }
  const source = readRepo(BOUNDS_TEST);
  const failures = [];
  if (!source.includes("LIMIT_DEFINITIONS")) {
    failures.push(`${BOUNDS_TEST} must iterate LIMIT_DEFINITIONS`);
  }
  if (!source.includes("at the limit plus one") || !source.includes("at the limit")) {
    failures.push(`${BOUNDS_TEST} must test each limit at the value and at value + 1`);
  }
  for (const definition of definitions) {
    if (!source.includes(definition.refusal) && !source.includes("definition.refusal")) {
      failures.push(`${BOUNDS_TEST} must assert the exact refusal text for ${definition.name}`);
    }
  }
  if (!source.includes("refuseLimit") || !source.includes("enforceLimit")) {
    failures.push(`${BOUNDS_TEST} must call enforceLimit/refuseLimit`);
  }
  return failures;
}

function unknownRationaleCount(definitions) {
  return definitions.filter((definition) => definition.rationale === "unknown").length;
}

function stripComments(source, kind) {
  if (kind === "sh") {
    return source.replaceAll(/(^|[\s])#[^\n]*/gu, "$1");
  }
  let output = "";
  let index = 0;
  let state = "code";
  while (index < source.length) {
    const current = source[index];
    const next = source[index + 1];
    if (state === "code") {
      if (current === "/" && next === "/") {
        state = "line";
        index += 2;
        continue;
      }
      if (current === "/" && next === "*") {
        state = "block";
        index += 2;
        continue;
      }
      if (current === '"' || current === "'" || current === "`") {
        state = current;
        output += current;
        index += 1;
        continue;
      }
      output += current;
      index += 1;
      continue;
    }
    if (state === "line") {
      if (current === "\n") {
        state = "code";
        output += current;
      }
      index += 1;
      continue;
    }
    if (state === "block") {
      if (current === "*" && next === "/") {
        state = "code";
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }
    output += current;
    if (current === "\\" && next) {
      output += next;
      index += 2;
      continue;
    }
    if (current === state) state = "code";
    index += 1;
  }
  return output;
}

function walkFiles(relativeRoot, files = []) {
  const absolute = join(repoRoot, relativeRoot);
  if (!existsSync(absolute)) return files;
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const relativePath = join(relativeRoot, entry.name).replaceAll("\\", "/");
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "test") continue;
    if (entry.isDirectory()) {
      walkFiles(relativePath, files);
      continue;
    }
    if (!entry.isFile()) continue;
    if (GENERATED_NAMES.has(entry.name)) continue;
    if (/\.(?:test|spec)\./u.test(entry.name)) continue;
    if (!/\.(?:ts|js|mjs|cjs|sh)$/u.test(entry.name)) continue;
    files.push(relativePath);
  }
  return files;
}

function normalizeLexeme(lexeme) {
  // Collapse numeric digit separators only. Identifier underscores are load-bearing
  // (`MAX_FOO_BYTES` must not become `MAXFOOBYTES`).
  let normalized = lexeme.replaceAll(/\s+/gu, " ").trim();
  let previous;
  do {
    previous = normalized;
    normalized = normalized.replaceAll(/(\d)_(\d)/gu, "$1$2");
  } while (normalized !== previous);
  return normalized;
}

/**
 * CI `rules:changes` patterns for a scan scope, rendered into the pipeline by
 * `.gitlab/ci/generate-runtime-derived-ci.mjs`. The job must be triggered by
 * everything the checker reads, or an MR touching only an unlisted input skips
 * the gate. Over-triggering costs a pipeline, so prefer the broader pattern.
 */
export function limitsScanCiPathPatterns(scope = "all", deployRoot = configuredDeployRoot()) {
  const roots = scopeScanRoots(scope, deployRoot);
  const patterns = new Set(roots.map((root) => `${root}/**/*`));
  // Inputs that change the verdict for every scope. blueprint-compliance.yml
  // and .gitlab-ci.yml sit outside the scan roots but are read unconditionally
  // by the SAST projection checks. BUILD_GENERATED_MIRRORS are not listed:
  // git does not track them, so no diff changes them, and each changes array
  // is capped at 50 entries.
  for (const input of [
    YAML_PATH,
    `${FRAGMENT_DIR}/**/*`,
    ALLOWLIST_PATH,
    `${ALLOWLIST_SHARD_DIR}/**/*`,
    ...(deployRoot === null ? [] : [deployShellMirrorPath(deployRoot)]),
    DEPLOY_ROOT_CONFIG_PATH,
    DEPLOY_ROOT_MODULE_PATH,
    JSON_MIRROR,
    CATALOG_JSON_MIRROR,
    TRAIN_REUSE_LIMITS_GENERATED,
    TRAIN_REUSE_LIMITS_CONSUMER,
    CHECKER_PATH,
    ALLOWLIST_SHARDS_MODULE_PATH,
    GITLAB_SAST_LIMITS_GENERATED,
    GITLAB_WSL2_GENERATED,
    GITLAB_ARTIFACT_RETENTION_GENERATED,
    BLUEPRINT_COMPLIANCE_PATH,
    GITLAB_CI_ROOT_PATH,
    GITLAB_RUNTIME_PATH,
    GITLAB_KNOWLEDGE_PATH,
    GITLAB_PUBLIC_EXPORT_PATH,
  ]) {
    patterns.add(input);
  }
  return [...patterns];
}

/**
 * The roots a scope scans. The deploy scope with no configured deploy root
 * refuses rather than scanning nothing.
 */
function scopeScanRoots(scope, deployRoot) {
  if (scope === "all") return allScanRoots(deployRoot);
  if (scope === "deploy" && deployRoot === null) {
    throw new Error(
      `--scope deploy needs a deploy root, and ${DEPLOY_ROOT_CONFIG_PATH} is absent from this tree; restore it, or check another scope`,
    );
  }
  return productScanRoots(deployRoot)[scope] ?? [];
}

export function scanBoundLiterals(scope = "all", deployRoot = configuredDeployRoot()) {
  const roots = scopeScanRoots(scope, deployRoot);
  const findings = [];
  for (const root of roots) {
    for (const path of walkFiles(root)) {
      const kind = path.endsWith(".sh") ? "sh" : "ts";
      const source = stripComments(readRepo(path), kind);
      for (const finding of matchBoundLiterals(source)) {
        findings.push({
          path,
          kind: finding.kind,
          lexeme: finding.lexeme,
        });
      }
    }
  }
  return canonicalizeFindings(findings);
}

function canonicalizeFindings(findings) {
  const counts = new Map();
  for (const finding of findings) {
    const key = `${finding.path}\t${finding.kind}\t${finding.lexeme}`;
    counts.set(key, (counts.get(key) ?? 0) + (finding.count ?? 1));
  }
  return [...counts.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, count]) => {
      const [path, kind, lexeme] = key.split("\t");
      return { path, kind, lexeme, count };
    });
}

function findingKey(finding) {
  return `${finding.path}\t${finding.kind}\t${finding.lexeme}\t${finding.count}`;
}

export function compareAllowlist(current, allowlist) {
  const expected = canonicalizeFindings(allowlist.literals ?? []);
  const currentKeys = new Set(current.map(findingKey));
  const expectedKeys = new Set(expected.map(findingKey));
  const extra = current.filter((finding) => !expectedKeys.has(findingKey(finding)));
  const missing = expected.filter((finding) => !currentKeys.has(findingKey(finding)));
  return { extra, missing };
}

/**
 * The composed allowlist: the root registry at config/limits-allowlist.json,
 * the shard row config/limits-deploy.json registers, and their per-owner
 * shards under config/limits-allowlist/. An absent root is an empty
 * allowlist. `repoRoot` defaults to this checkout, and the deploy root is read
 * from it.
 */
export function loadAllowlist(options = {}) {
  const root = options.repoRoot ?? repoRoot;
  const deployRoot = configuredDeployRoot(root);
  return loadAllowlistShards({
    repoRoot: root,
    scanRoots: allScanRoots(deployRoot),
    absentRoots: options.absentRoots ?? [],
    configuredShards: configuredShards(deployRoot),
  });
}

function absentScanRoots(deployRoot) {
  return allScanRoots(deployRoot).filter((root) => !presentInRepo(root));
}

function underRoot(path, roots) {
  return roots.some((root) => path === root || path.startsWith(`${root}/`));
}

/**
 * The writer's read: the shards registry plus every rationale written down,
 * including a legacy root's `literals` (limits-allowlist-shards.mjs
 * loadAllowlistForRewrite). The gate never uses it.
 */
function loadAllowlistRationales(deployRoot) {
  return loadAllowlistForRewrite({
    repoRoot,
    scanRoots: allScanRoots(deployRoot),
    configuredShards: configuredShards(deployRoot),
  });
}

/**
 * The catalog `runLimitsTool` works from. A caller that lists the mirrors and
 * then checks them passes one result to both calls, so the catalog is read
 * once. `loadOptions` goes to `loadLimitDefinitions`.
 */
export function prepareLimitsTool(loadOptions = {}) {
  return { definitions: loadLimitDefinitions(loadOptions), deployRoot: configuredDeployRoot() };
}

/**
 * Write the build-generated mirrors that are missing or differ from a fresh
 * render, and nothing else: a committed output is never rewritten, so a check
 * of the committed outputs that runs afterwards still sees their drift. For
 * check-mode tools that import runtime source. Returns the paths written.
 */
export function writeBuildGeneratedMirrors(prepared = prepareLimitsTool()) {
  const mirrors = renderMirrors(prepared.definitions, prepared.deployRoot);
  const owners = mirrorOwners(prepared.deployRoot);
  const written = [];
  for (const path of BUILD_GENERATED_MIRRORS) {
    const owner = owners[path];
    // Handles exactly a mirror whose owner package is absent from this tree,
    // as generation skips it; a present owner gets its mirror written.
    if (owner !== undefined && !presentInRepo(owner)) continue;
    if (presentInRepo(path) && readRepo(path) === mirrors[path]) continue;
    // Replaced by rename, so a process importing the mirror meanwhile reads
    // either the old bytes or the new ones, never a truncated file.
    const absolute = join(repoRoot, path);
    const staging = `${absolute}.${process.pid}.staging`;
    try {
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(staging, mirrors[path]);
      renameSync(staging, absolute);
    } finally {
      rmSync(staging, { force: true });
    }
    written.push(path);
  }
  return written;
}

export async function runLimitsTool(options, prepared = prepareLimitsTool()) {
  const { definitions, deployRoot } = prepared;
  if (options.printMirrorPaths) {
    // Derived from `renderMirrors` itself, not a separate constant, so a new
    // mirror cannot be missing from the listing its consumers back up.
    return { status: "mirror-paths", paths: Object.keys(renderMirrors(definitions, deployRoot)) };
  }
  if (options.hostFile) {
    const path = resolve(options.hostFile);
    const values = parseHostLimitAssignments(readFileSync(path, "utf8"), path);
    const { presentKeys } = resolveHostLimitOverrides(definitions, {}, values);
    resolveLimitDefinitions(definitions, { hostValues: values });
    return {
      status: "host-overrides-checked",
      keys: [...presentKeys].filter((key) => key.startsWith("DOCSFAB_")).sort(),
    };
  }
  const mirrors = renderMirrors(definitions, deployRoot);
  const skipped = [];
  if (deployRoot === null) skipped.push(deployUnconfiguredSkip("deploy shell mirror"));
  const owners = mirrorOwners(deployRoot);
  const ownedMirrors = Object.entries(mirrors).filter(([path]) => {
    const owner = owners[path];
    if (owner === undefined || presentInRepo(owner)) return true;
    skipped.push(ownerAbsentSkip(path, owner));
    return false;
  });
  if (!options.checkOnly && !options.writeAllowlist) {
    for (const [path, contents] of ownedMirrors) writeRepo(path, contents);
    // The doc generator reads the catalog mirror the loop above just wrote.
    // `options.docTablesDir` is a test-only override.
    runDocsLimitsTool({ checkOnly: false, tablesDir: options.docTablesDir });
    return {
      status: "generated",
      paths: [...ownedMirrors.map(([path]) => path), ...LIMITS_DOC_TABLE_PATHS],
      skipped,
    };
  }
  if (options.writeAllowlist) {
    // Rewriting from a partial tree would empty the shards of every absent
    // root and drop their rationales.
    const absent = absentScanRoots(deployRoot);
    if (absent.length > 0) {
      throw new Error(
        `--write-allowlist needs every scanned root; absent from this tree: ${absent.join(", ")}. Rewriting would empty their shards and drop their rationales; run it in the full repository`,
      );
    }
    // Without the deploy configuration the deploy shard would be left
    // unregistered, its literals unscanned.
    if (deployRoot === null) {
      throw new Error(
        `--write-allowlist needs the deploy root, and ${DEPLOY_ROOT_CONFIG_PATH} is absent from this tree; run it in the full repository`,
      );
    }
    // Partitioned into the registered shards; each finding keeps the
    // rationale any shard, or a legacy root literals list, carried for it.
    const { files, count, shards } = renderAllowlistFiles({
      findings: scanBoundLiterals("all", deployRoot),
      previous: loadAllowlistRationales(deployRoot),
      unknownRationaleBudget: unknownRationaleCount(definitions),
    });
    for (const [path, contents] of Object.entries(files)) writeRepo(path, contents);
    return { status: "allowlist-written", count, shards };
  }
  // Narrows only the mirror comparison below; the doc tables, sealed entries,
  // GitLab projections and the gate still run.
  const checkedMirrors = options.committedOnly
    ? ownedMirrors.filter(([path]) => {
        if (!BUILD_GENERATED_MIRRORS.includes(path)) return true;
        skipped.push(
          `${path}: not checked here, the build generates it (scripts/ensure-derived.mjs)`,
        );
        return false;
      })
    : ownedMirrors;
  const failures = [];
  for (const [path, contents] of checkedMirrors) {
    if (!existsSync(join(repoRoot, path)) || readRepo(path) !== contents) {
      failures.push(`${path} drifted from ${YAML_PATH}; run npm run generate:limits`);
    }
  }
  // Check the doc tables against the freshly rendered catalog, not the
  // possibly stale on-disk mirror. `options.docTablesDir` is a test-only override.
  {
    const freshCatalog = JSON.parse(mirrors[CATALOG_JSON_MIRROR]).limits;
    const docsResult = runDocsLimitsTool({
      checkOnly: true,
      catalog: freshCatalog,
      tablesDir: options.docTablesDir,
    });
    if (docsResult.status === "drifted") failures.push(...docsResult.messages);
  }
  failures.push(...verifySealed(definitions));
  for (const [owner, verify] of [
    [
      GITLAB_RUNTIME_PATH,
      (text) => [
        ...verifyGitlabLiveModelProjection(text),
        ...verifyGitlabWsl2Projection(text),
        ...verifyGitlabArtifactRetentionProjection({ [GITLAB_RUNTIME_PATH]: text }),
      ],
    ],
    [
      GITLAB_KNOWLEDGE_PATH,
      (text) => verifyGitlabArtifactRetentionProjection({ [GITLAB_KNOWLEDGE_PATH]: text }),
    ],
    [
      GITLAB_PUBLIC_EXPORT_PATH,
      (text) => verifyGitlabArtifactRetentionProjection({ [GITLAB_PUBLIC_EXPORT_PATH]: text }),
    ],
    [BLUEPRINT_COMPLIANCE_PATH, (text) => verifyGitlabSastProjection(text, definitions)],
    [
      GITLAB_CI_ROOT_PATH,
      (text) => [
        ...verifyGitlabSastIncludePresence(text),
        ...verifyGitlabArtifactRetentionIncludePresence(text),
        ...verifyGitlabWsl2IncludePresence(text),
      ],
    ],
  ]) {
    if (presentInRepo(owner)) {
      failures.push(...verify(readRepo(owner)));
    } else {
      skipped.push(ownerAbsentSkip(`${owner} limits projection`, owner));
    }
  }
  const runGate = options.gate === true || options.scope !== "all";
  if (runGate && (options.scope === "all" || options.scope === "runtime")) {
    failures.push(...verifyBoundTests(definitions));
  }
  if (runGate) {
    const unknown = unknownRationaleCount(definitions);
    // An absent scan root has no literals to compare and may lack its shard;
    // a present root keeps every stale-entry and missing-shard refusal.
    const absentRoots = absentScanRoots(deployRoot);
    const allowlist = loadAllowlist({ absentRoots });
    const budget = allowlist.unknownRationaleBudget ?? 0;
    if (unknown > budget) {
      failures.push(`unknown rationale count ${unknown} exceeds budget ${budget}`);
    }
    const scopeRoots = scopeScanRoots(options.scope, deployRoot);
    const current = scanBoundLiterals(options.scope, deployRoot);
    for (const root of scopeRoots.filter((root) => absentRoots.includes(root))) {
      skipped.push(`${root} literal scan: skipped, the scan root is absent from this tree`);
    }
    // Handles exactly the unscoped gate in a tree without a deploy root; a
    // runtime or host scope never scans the deploy root, and --scope deploy
    // refused above.
    if (deployRoot === null && options.scope === "all") {
      skipped.push(deployUnconfiguredSkip("deploy literal scan"));
    }
    const scopedAllowlist = (allowlist.literals ?? []).filter(
      (finding) =>
        !underRoot(finding.path, absentRoots) &&
        (options.scope === "all" || underRoot(finding.path, scopeRoots)),
    );
    const { extra, missing } = compareAllowlist(current, { literals: scopedAllowlist });
    if (extra.length > 0) {
      failures.push(
        `un-allowlisted bound literals:\n${extra
          .slice(0, 20)
          .map((finding) => `  ${finding.path} ${finding.kind} ${finding.lexeme} x${finding.count}`)
          .join("\n")}`,
      );
    }
    if (options.scope === "all" && missing.length > 0) {
      failures.push(
        `${ALLOWLIST_SHARD_DIR}/ has stale entries; shrink the shard named on each line:\n${missing
          .slice(0, 20)
          .map(
            (finding) =>
              `  ${finding.path} ${finding.kind} ${finding.lexeme} (${shardPathForLiteral(finding.path, allowlist.shards)})`,
          )
          .join("\n")}`,
      );
    }
  }
  if (failures.length > 0) {
    const error = new Error(failures.join("\n"));
    error.failures = failures;
    throw error;
  }
  return { status: "checked", count: definitions.length, skipped };
}

function isMain() {
  // Realpath both sides: `import.meta.url` is symlink-resolved but argv[1] is
  // not, and a mismatch would exit 0 having checked nothing. Falls back to the
  // unresolved path only when the file cannot be stat'd.
  const real = (value) => {
    try {
      return realpathSync(value);
    } catch {
      return value;
    }
  };
  const invoked = process.argv[1] ? real(resolve(process.argv[1])) : "";
  return invoked === real(fileURLToPath(import.meta.url));
}

if (isMain()) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = await runLimitsTool(options);
    for (const line of result.skipped ?? []) console.log(line);
    if (result.status === "mirror-paths") {
      process.stdout.write(`${result.paths.join("\n")}\n`);
    } else if (result.status === "host-overrides-checked") {
      process.stdout.write(result.keys.length > 0 ? `${result.keys.join("\n")}\n` : "");
    } else if (result.status === "generated") {
      console.log(`Updated limits mirrors: ${result.paths.join(", ")}`);
    } else if (result.status === "allowlist-written") {
      console.log(
        `Wrote ${ALLOWLIST_PATH} and ${result.shards} shards under ${ALLOWLIST_SHARD_DIR}/ with ${result.count} literal findings`,
      );
    } else {
      console.log(`Limits configuration is current (${result.count} entries)`);
    }
  } catch (error) {
    console.error(`check:limits failed: ${error.message}`);
    process.exitCode = 1;
  }
}
