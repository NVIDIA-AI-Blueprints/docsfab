// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * Frozen unofficial host→runtime SDK: POSIX repo-relative paths as resolved
 * from packages/host/src/.
 * New host src deep-imports of packages/runtime/ fail unless added here.
 */
export const HOST_RUNTIME_IMPORT_ALLOW = Object.freeze([
  "packages/runtime/src/candidate-source-manifest.js",
  "packages/runtime/src/channels/slack/transport.ts",
  "packages/runtime/src/cli/comment-existing-mr-glab.ts",
  "packages/runtime/src/cli/comment-existing-mr.ts",
  "packages/runtime/src/context/reader-context.ts",
  // The host status projection uses the runtime-owned parser and inspection API
  // so service limits cannot drift into a second host implementation.
  "packages/runtime/src/config/limits.ts",
  // Dependency-free override parser. Host install and recovery call this
  // module directly so strip-types does not have to load the runtime loader.
  "packages/runtime/src/config/limit-resolution.js",
  // The single generated limits catalog. It has no imports, so it loads under
  // strip-types; host reads it here instead of carrying a byte-identical copy.
  "packages/runtime/src/config/limits.generated.ts",
  "packages/runtime/src/delivery/contracts.ts",
  "packages/runtime/src/delivery/delivery-authority.ts",
  "packages/runtime/src/delivery/host-routing.ts",
  "packages/runtime/src/delivery/index.ts",
  "packages/runtime/src/delivery/preflight.ts",
  "packages/runtime/src/delivery/repository-event-routing.ts",
  "packages/runtime/src/delivery/update-existing-mr/index.ts",
  "packages/runtime/src/host-invoker/contracts.ts",
  // The signed-plan verifier for an approved native import. The host loads it
  // only through its runtime loader bridge, never under strip-types; it verifies
  // a reviewer signature against protected policy and grants no write itself.
  "packages/runtime/src/host-invoker/native-approval.ts",
  // One pure formatter shared by the retained runtime answer and host delivery;
  // it imports no runtime state, model, credentials, or execution authority.
  "packages/runtime/src/live-agent/answer-chunks.ts",
  // Pure question-frame sizing shares no runtime state or authority.
  "packages/runtime/src/live-agent/input-envelope.ts",
  "packages/runtime/src/model/configuration.ts",
  "packages/runtime/src/operator/cli-format.ts",
  // The closed failure-class vocabulary. It has no imports, so it loads under
  // strip-types; host classifies dispatcher failures on the runtime's list
  // instead of a copy that could drift.
  "packages/runtime/src/operator/failure-class.ts",
  "packages/runtime/src/reader-task-transport.js",
  "packages/runtime/src/records/contracts.ts",
  "packages/runtime/src/records/host-progress.ts",
  // The one agent instruction file list and the operator-naming rule. The host
  // grant and the hosted runner leave the same unnamed files unbound; neither
  // module holds state or authority, and their graph is node:crypto only.
  "packages/runtime/src/repository/agent-instruction-files.ts",
  "packages/runtime/src/repository/operator-named-paths.ts",
  "packages/runtime/src/review/contracts.ts",
  "packages/runtime/src/review/index.js",
  // The configured-credential registry (#1807): host loaders register the
  // credentials they read from files, which the exact-match screens refuse.
  "packages/runtime/src/security/configured-credentials.ts",
  "packages/runtime/src/security/credential-material.ts",
  // The credential-like-content screens and finding scopes (#1807). Host
  // screens refuse only DocsFab's configured credentials and record shapes by
  // the runtime's rules; its graph is NodeNext `.js` leaves for strip-types.
  "packages/runtime/src/security/credential-shape-findings.ts",
  // The one egress screen and its declared public roots. Host publishers
  // replace this host's roots and screen credentials by the runtime's rule.
  "packages/runtime/src/security/egress.ts",
  "packages/runtime/src/security/public-roots.ts",
  // The shared credential shapes. No imports, state or authority; one list so
  // the host screens and runtime screens cannot drift.
  "packages/runtime/src/security/text-credential-shapes.js",
  "packages/runtime/src/workflow-contracts/outcome.ts",
  // The required-check limitation lines a hosted Slack result repeats (#1918).
  // It has no imports, so it loads under strip-types; one prefix, no copy.
  "packages/runtime/src/workflow-execution/required-check-limitation.ts",
]);

/**
 * Frozen façade rules. Prefixes are repo-relative and POSIX. No
 * packages/contracts tree.
 * Product packages must not import mill meta-work under scripts/orchestration/.
 * Other root scripts/ stay allowed.
 * Host src may import only HOST_RUNTIME_IMPORT_ALLOW from runtime; host
 * tests/fixtures are outside that ratchet (importer is packages/host/src/).
 */
export const IMPORT_RULES = Object.freeze([
  Object.freeze({
    importer: "packages/knowledge/",
    forbid: Object.freeze([
      "packages/runtime/",
      "packages/quality/",
      "packages/host/",
      "scripts/orchestration/",
    ]),
  }),
  Object.freeze({
    importer: "packages/quality/",
    forbid: Object.freeze([
      "packages/runtime/",
      "packages/knowledge/",
      "packages/host/",
      "scripts/orchestration/",
    ]),
  }),
  Object.freeze({
    importer: "packages/runtime/",
    forbid: Object.freeze([
      "packages/knowledge/",
      "packages/quality/",
      "packages/skills/",
      "packages/host/",
      "scripts/orchestration/",
    ]),
  }),
  Object.freeze({
    importer: "packages/skills/",
    forbid: Object.freeze([
      "packages/runtime/src/",
      "packages/knowledge/src/",
      "experiments/",
      "scripts/orchestration/",
    ]),
  }),
  Object.freeze({
    importer: "packages/host/",
    forbid: Object.freeze(["scripts/orchestration/"]),
  }),
  Object.freeze({
    importer: "packages/host/src/",
    forbid: Object.freeze(["packages/runtime/"]),
    allow: HOST_RUNTIME_IMPORT_ALLOW,
  }),
]);

const SOURCE_EXT = Object.freeze([".js", ".ts", ".mjs", ".cjs", ".jsx", ".tsx"]);
const SKIP_DIRS = Object.freeze(
  new Set([
    "node_modules",
    ".git",
    "dist",
    "coverage",
    ".turbo",
    ".docsfab",
    "__pycache__",
    ".venv",
  ]),
);
// The package builder removes or renames this temporary tree after publishing dist.
const GENERATED_DIST_STAGING_DIR_RE = /^dist\.staging-\d+$/u;

const STATIC_IMPORT_RE =
  /\b(?:import|export)\s+(?:(?:type\s+)?[\s\S]*?\sfrom\s+)?['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const REQUIRE_RE = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function toPosix(path) {
  return path.split(sep).join("/");
}

/**
 * Follow ancestor symlinks so `/var` and `/private/var` compare equal, even
 * when the leaf does not exist.
 */
const canonicalCache = new Map();

function canonicalPath(absolutePath) {
  const resolved = resolve(absolutePath);
  const cached = canonicalCache.get(resolved);
  if (cached !== undefined) return cached;
  let result;
  try {
    result = realpathSync(resolved);
  } catch {
    const parent = dirname(resolved);
    result = parent === resolved ? resolved : resolve(canonicalPath(parent), basename(resolved));
  }
  canonicalCache.set(resolved, result);
  return result;
}

function parseArgs(argv) {
  let root = defaultRoot;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("check-package-imports: --root requires a directory");
      }
      root = value;
      i += 1;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      return { help: true, root };
    }
    if (arg.startsWith("-")) {
      throw new Error(`check-package-imports: unknown option ${arg}`);
    }
    root = arg;
  }
  return { help: false, root: canonicalPath(root) };
}

function isSourceFile(name) {
  if (name.endsWith(".d.ts")) return false;
  return SOURCE_EXT.some((ext) => name.endsWith(ext));
}

function listSourceFiles(directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    if (entry.isDirectory() && GENERATED_DIST_STAGING_DIR_RE.test(entry.name)) continue;
    if (entry.isSymbolicLink()) continue;
    const full = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(full));
    } else if (entry.isFile() && isSourceFile(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

function collectImportSpecs(filePath) {
  const text = readFileSync(filePath, "utf8");
  const specs = [];
  for (const pattern of [STATIC_IMPORT_RE, DYNAMIC_IMPORT_RE, REQUIRE_RE]) {
    for (const match of text.matchAll(pattern)) {
      specs.push(match[1]);
    }
  }
  return specs;
}

function packageRoots(root) {
  const packagesDir = resolve(root, "packages");
  if (!existsSync(packagesDir)) return [];

  const mappings = [];
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
    const manifestPath = resolve(packagesDir, entry.name, "package.json");
    if (!existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (typeof manifest.name === "string" && manifest.name.length > 0) {
        mappings.push({
          name: manifest.name,
          path: `packages/${entry.name}`,
        });
      }
    } catch {
      // A malformed package manifest should not prevent checking other trees.
    }
  }
  return mappings.sort((left, right) => right.name.length - left.name.length);
}

function mapPackageSpecifier(spec, mappings) {
  for (const mapping of mappings) {
    if (spec === mapping.name) return mapping.path;
    if (spec.startsWith(`${mapping.name}/`)) {
      return `${mapping.path}${spec.slice(mapping.name.length)}`;
    }
  }
  return null;
}

function hitsPrefix(relPosix, prefix) {
  const normalized = prefix.endsWith("/") ? prefix : `${prefix}/`;
  const exact = normalized.slice(0, -1);
  return relPosix === exact || relPosix.startsWith(normalized);
}

function repoRelative(root, absolutePath) {
  const resolved = resolve(absolutePath);
  const lexical = toPosix(relative(root, resolved));
  if (!lexical || lexical === ".") return "";
  if (!lexical.startsWith("..")) return lexical;

  const canonical = toPosix(relative(canonicalPath(root), canonicalPath(resolved)));
  if (!canonical || canonical === ".") return "";
  if (canonical.startsWith("..")) return null;
  return canonical;
}

function resolveFileSpecifier(fromFile, spec, root) {
  const rest = spec.slice("file:".length);
  if (rest.startsWith("//")) {
    try {
      return fileURLToPath(spec);
    } catch {
      return null;
    }
  }
  if (rest.startsWith(".")) {
    return resolve(dirname(fromFile), rest);
  }
  if (isAbsolute(rest)) {
    return rest;
  }
  return resolve(root, rest);
}

function resolveWorkspaceSpecifier(fromFile, spec, root) {
  const rest = spec.slice("workspace:".length);
  if (!rest || rest === "*" || rest === "^" || rest === "~") return null;
  if (rest.startsWith(".")) {
    return resolve(dirname(fromFile), rest);
  }
  if (isAbsolute(rest)) {
    return rest;
  }
  return resolve(root, rest);
}

function resolveSpecifierPath(fromFile, spec, root, mappings) {
  if (spec.startsWith("file:")) {
    return resolveFileSpecifier(fromFile, spec, root);
  }
  if (spec.startsWith("workspace:")) {
    return resolveWorkspaceSpecifier(fromFile, spec, root);
  }
  if (spec.startsWith(".")) {
    return resolve(dirname(fromFile), spec);
  }
  const mapped = mapPackageSpecifier(spec, mappings);
  return mapped ? resolve(root, mapped) : null;
}

function forbiddenMatch(relPosix, forbid) {
  return forbid.find((prefix) => hitsPrefix(relPosix, prefix)) ?? null;
}

function isAllowedImport(relPosix, allow) {
  return Array.isArray(allow) && allow.includes(relPosix);
}

function specifierHitsForbidden(spec, forbid, mappings) {
  const posix = mapPackageSpecifier(spec, mappings) ?? toPosix(spec);
  return forbiddenMatch(posix, forbid);
}

/**
 * Scan importer trees for façade-crossing JS/TS/MJS import specifiers.
 * @param {{ root?: string, importers?: readonly string[] }} [options]
 */
export function findPackageImportViolations(options = {}) {
  const root = canonicalPath(options.root ?? defaultRoot);
  const mappings = packageRoots(root);
  const violations = [];
  const requestedImporters = options.importers;
  if (
    requestedImporters !== undefined &&
    (!Array.isArray(requestedImporters) ||
      requestedImporters.length === 0 ||
      requestedImporters.some(
        (importer) => !IMPORT_RULES.some((rule) => rule.importer === importer),
      ))
  ) {
    throw new Error(
      "check-package-imports: importers must be a non-empty list of known importer roots",
    );
  }
  const rules =
    requestedImporters === undefined
      ? IMPORT_RULES
      : IMPORT_RULES.filter((rule) => requestedImporters.includes(rule.importer));

  for (const rule of rules) {
    const importerRoot = resolve(root, rule.importer);
    for (const filePath of listSourceFiles(importerRoot)) {
      const importer = repoRelative(root, filePath);
      if (!importer) continue;

      for (const spec of collectImportSpecs(filePath)) {
        const prefixHit = specifierHitsForbidden(spec, rule.forbid, mappings);
        if (prefixHit) {
          const mapped = mapPackageSpecifier(spec, mappings);
          const resolved = mapped ?? toPosix(spec);
          if (!isAllowedImport(resolved, rule.allow)) {
            violations.push({
              importer,
              spec,
              resolved,
              prefix: prefixHit,
            });
          }
          continue;
        }

        const absolute = resolveSpecifierPath(filePath, spec, root, mappings);
        if (!absolute) continue;
        const resolved = repoRelative(root, absolute);
        if (!resolved) continue;
        const resolvedHit = forbiddenMatch(resolved, rule.forbid);
        if (!resolvedHit || isAllowedImport(resolved, rule.allow)) continue;
        violations.push({
          importer,
          spec,
          resolved,
          prefix: resolvedHit,
        });
      }
    }
  }

  return violations;
}

export function formatPackageImportReport(violations) {
  if (violations.length === 0) return [];
  const lines = ["Forbidden cross-package imports:"];
  for (const violation of violations) {
    lines.push(
      `- ${violation.importer} imports ${violation.spec} → ${violation.resolved} (${violation.prefix})`,
    );
  }
  return lines;
}

function usage() {
  console.log(`Usage: node packages/runtime/scripts/check-package-imports.mjs [--root <dir>]`);
}

export function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    usage();
    return 0;
  }
  if (!existsSync(parsed.root)) {
    console.error(`check-package-imports: root not found: ${parsed.root}`);
    return 2;
  }

  const violations = findPackageImportViolations({ root: parsed.root });
  const lines = formatPackageImportReport(violations);
  if (lines.length > 0) {
    for (const line of lines) console.error(line);
    return 1;
  }
  console.log(`Verified package façade imports (${IMPORT_RULES.length} importer trees).`);
  return 0;
}

// Realpath both sides: `import.meta.url` is symlink-resolved but argv[1] is
// not, and a mismatch would exit 0 having checked nothing. Falls back to the
// unresolved path only when the file cannot be stat'd.
function isMain() {
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
  process.exitCode = main();
}
