// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const defaultSrcRoot = join(root, "src");
const exceptionsPath = join(root, "scripts/soft-deps-exceptions.json");

/**
 * Soft product-package roots from docs/reference/operations/soft-dependencies.md.
 * Paths are src-relative with trailing slash for directories.
 */
export const PACKAGE_ROOTS = Object.freeze({
  // Maturity is listed first so publication can be barred from selection without
  // forbidding delivery's existing inventory/search/outcome evidence imports.
  maturity: Object.freeze(["maturity/"]),
  assessment: Object.freeze(["repository/", "search/"]),
  publication: Object.freeze(["delivery/"]),
  autonomy: Object.freeze(["autonomy/", "lineage/", "inputs/"]),
  roadmap: Object.freeze(["roadmap/"]),
});

/** Packages that count as "assessment" for the no-delivery rule. */
export const ASSESSMENT_PACKAGES = Object.freeze(["assessment", "maturity"]);

export const RULES = Object.freeze([
  Object.freeze({
    id: "assessment-must-not-import-publication",
    description:
      "assessment must not import delivery/publication (inventory, search, maturity, and outcomes stay free of worktree/receipt/SCM adapter types)",
    from: Object.freeze(["assessment", "maturity"]),
    forbid: Object.freeze(["publication"]),
  }),
  Object.freeze({
    id: "publication-must-not-own-maturity-selection",
    description:
      "publication must not own maturity selection (delivery must not import src/maturity)",
    from: Object.freeze(["publication"]),
    forbid: Object.freeze(["maturity"]),
  }),
]);

/** Autonomy may import assessment and roadmap façades — documented, not forbidden. */
export const ALLOWED_AUTONOMY_IMPORTS = Object.freeze(["assessment", "maturity", "roadmap"]);

/** File-graph rules share the existing exception ratchet. */
export const CYCLE_RULE_ID = "no-value-import-cycles";
export const CONTRACT_LAYERING_RULE_ID = "contract-must-not-import-cyclic-module";
export const GRAPH_RULE_IDS = Object.freeze([CYCLE_RULE_ID, CONTRACT_LAYERING_RULE_ID]);

const CONTRACT_BASENAME_RE = /contract/iu;
// Accepted contract surfaces include the workflow contract
// family and init's shared types even when the basename does not say contract.
const CONTRACT_SURFACE_ROOTS = Object.freeze(["workflow-contracts/"]);
const CONTRACT_SURFACE_FILES = new Set(["init/types.ts"]);

const IMPORT_RE = /(?:(?:import|export)(?:[\s\w{},*]+from)?\s*|import\s*\(\s*)['"]([^'"]+)['"]/g;

function toPosix(path) {
  return path.split(sep).join("/");
}

const KNOWN_EXCEPTION_RULE_IDS = new Set([...RULES.map((rule) => rule.id), ...GRAPH_RULE_IDS]);

function loadExceptions() {
  if (!existsSync(exceptionsPath)) return [];
  const raw = JSON.parse(readFileSync(exceptionsPath, "utf8"));
  if (!Array.isArray(raw.exceptions)) {
    throw new Error(`${exceptionsPath} must contain an "exceptions" array`);
  }
  return raw.exceptions.map((entry, index) => {
    for (const key of ["rule", "importer", "imported", "reason"]) {
      if (typeof entry[key] !== "string" || entry[key].trim() === "") {
        throw new Error(`${exceptionsPath} exceptions[${index}].${key} must be a non-empty string`);
      }
    }
    if (!KNOWN_EXCEPTION_RULE_IDS.has(entry.rule)) {
      throw new Error(
        `${exceptionsPath} exceptions[${index}].rule "${entry.rule}" is not a known rule id ` +
          `(expected one of: ${[...KNOWN_EXCEPTION_RULE_IDS].join(", ")})`,
      );
    }
    return Object.freeze({
      rule: entry.rule,
      importer: toPosix(entry.importer),
      imported: toPosix(entry.imported),
      reason: entry.reason,
      tracking: typeof entry.tracking === "string" ? entry.tracking : undefined,
    });
  });
}

function classifyPackage(srcRelative) {
  const rel = toPosix(srcRelative);
  for (const [name, roots] of Object.entries(PACKAGE_ROOTS)) {
    for (const rootPath of roots) {
      if (rootPath.endsWith(".ts")) {
        if (rel === rootPath) return name;
      } else if (rel.startsWith(rootPath)) {
        return name;
      }
    }
  }
  return null;
}

function listTypeScriptFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      files.push(...listTypeScriptFiles(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      files.push(full);
    }
  }
  return files;
}

function resolveImport(fromFile, spec, scanRoot) {
  if (!spec.startsWith(".")) return null;
  let cleaned = spec;
  if (cleaned.endsWith(".js") || cleaned.endsWith(".mjs") || cleaned.endsWith(".cjs")) {
    cleaned = cleaned.slice(0, cleaned.lastIndexOf("."));
  }
  const base = resolve(dirname(fromFile), cleaned);
  const candidates = [
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
    base,
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      const rel = relative(scanRoot, candidate);
      if (rel.startsWith("..")) return null;
      return toPosix(rel);
    }
  }
  return null;
}

function collectImports(text) {
  const specs = [];
  for (const match of text.matchAll(IMPORT_RE)) {
    specs.push(match[1]);
  }
  return specs;
}

/**
 * Collect runtime edges from static import declarations and export-from
 * declarations. Type-only declarations, including named clauses whose every
 * specifier is type-only, do not load the target and therefore do not create
 * graph edges. Dynamic import() is deliberately outside this static graph.
 */
function collectStaticImportSpecifiers(filePath, text) {
  const source = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const all = [];
  const values = [];

  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const spec = statement.moduleSpecifier.text;
      all.push(spec);
      const clause = statement.importClause;
      if (!clause) {
        values.push(spec);
        continue;
      }
      if (clause.isTypeOnly) continue;

      let hasValueBinding = Boolean(clause.name);
      if (!hasValueBinding && clause.namedBindings) {
        hasValueBinding = ts.isNamespaceImport(clause.namedBindings)
          ? true
          : clause.namedBindings.elements.some((element) => !element.isTypeOnly);
      }
      // `import {} from "..."` still evaluates the imported module.
      if (hasValueBinding || !clause.namedBindings) {
        values.push(spec);
      } else if (
        ts.isNamedImports(clause.namedBindings) &&
        clause.namedBindings.elements.length === 0
      ) {
        values.push(spec);
      }
      continue;
    }

    if (!ts.isExportDeclaration(statement)) continue;
    if (!statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const spec = statement.moduleSpecifier.text;
    all.push(spec);
    if (statement.isTypeOnly) continue;

    if (
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause) &&
      statement.exportClause.elements.length > 0 &&
      statement.exportClause.elements.every((element) => element.isTypeOnly)
    ) {
      continue;
    }
    // `export *`, `export * as ns`, `export { value }`, and even an empty
    // export-from clause evaluate the target module.
    values.push(spec);
  }

  return { all, values };
}

/** Collect every import view once, before applying package labels or graph rules. */
function scanSourceTree(scanRoot) {
  const absoluteFiles = listTypeScriptFiles(scanRoot);
  const files = absoluteFiles.map((file) => toPosix(relative(scanRoot, file))).sort();
  const allEdges = new Map(files.map((file) => [file, new Set()]));
  const valueEdges = new Map(files.map((file) => [file, new Set()]));
  const softImports = new Map(files.map((file) => [file, []]));
  const byRelativePath = new Map(
    absoluteFiles.map((file) => [toPosix(relative(scanRoot, file)), file]),
  );

  for (const file of files) {
    const filePath = byRelativePath.get(file);
    const text = readFileSync(filePath, "utf8");
    const staticImports = collectStaticImportSpecifiers(filePath, text);
    for (const spec of staticImports.all) {
      const imported = resolveImport(filePath, spec, scanRoot);
      if (imported && allEdges.has(imported)) allEdges.get(file).add(imported);
    }
    for (const spec of staticImports.values) {
      const imported = resolveImport(filePath, spec, scanRoot);
      if (imported && valueEdges.has(imported)) valueEdges.get(file).add(imported);
    }
    // Preserve the legacy soft-package rule's broader regex semantics,
    // including dynamic imports, while sharing this single source-tree walk.
    for (const spec of collectImports(text)) {
      const imported = resolveImport(filePath, spec, scanRoot);
      if (imported && allEdges.has(imported)) softImports.get(file).push({ imported, spec });
    }
  }

  return { files, allEdges, valueEdges, softImports };
}

/** Tarjan's algorithm over the complete file graph. */
function computeStronglyConnectedComponents(files, edges) {
  let nextIndex = 0;
  const stack = [];
  const onStack = new Set();
  const indices = new Map();
  const lowlinks = new Map();
  const componentOf = new Map();
  const components = [];

  function visit(file) {
    indices.set(file, nextIndex);
    lowlinks.set(file, nextIndex);
    nextIndex += 1;
    stack.push(file);
    onStack.add(file);

    for (const imported of edges.get(file) ?? []) {
      if (!indices.has(imported)) {
        visit(imported);
        lowlinks.set(file, Math.min(lowlinks.get(file), lowlinks.get(imported)));
      } else if (onStack.has(imported)) {
        lowlinks.set(file, Math.min(lowlinks.get(file), indices.get(imported)));
      }
    }

    if (lowlinks.get(file) !== indices.get(file)) return;
    const component = [];
    let member;
    do {
      member = stack.pop();
      onStack.delete(member);
      component.push(member);
      componentOf.set(member, components.length);
    } while (member !== file);
    components.push(component.sort());
  }

  for (const file of files) {
    if (!indices.has(file)) visit(file);
  }
  return { componentOf, components };
}

function isCyclicComponent(component, edges) {
  return component.length > 1 || edges.get(component[0])?.has(component[0]) === true;
}

function topLevelModuleOf(path) {
  const slash = path.indexOf("/");
  return slash === -1 ? "<root>" : path.slice(0, slash);
}

function isContractSurfacePath(path) {
  const basename = path.slice(path.lastIndexOf("/") + 1);
  return (
    CONTRACT_BASENAME_RE.test(basename) ||
    CONTRACT_SURFACE_ROOTS.some((rootPath) => path.startsWith(rootPath)) ||
    CONTRACT_SURFACE_FILES.has(path)
  );
}

/**
 * Scan the complete src graph for new value-import cycles and cross-module
 * contract-surface imports into implementation files that are themselves in a
 * cycle. A genuine leaf (zero internal static imports) is always exempt from
 * the contract rule.
 *
 * @param {{
 *   exceptions?: Array<{rule: string, importer: string, imported: string, reason?: string}>,
 *   srcRoot?: string,
 *   sourceGraph?: ReturnType<typeof scanSourceTree>,
 * }} [options]
 */
export function findGraphGuardViolations(options = {}) {
  const exceptions = (options.exceptions ?? loadExceptions()).filter((entry) =>
    GRAPH_RULE_IDS.includes(entry.rule),
  );
  const scanRoot = options.srcRoot ? resolve(options.srcRoot) : defaultSrcRoot;
  const { files, allEdges, valueEdges: edges } = options.sourceGraph ?? scanSourceTree(scanRoot);
  const { components: allComponents } = computeStronglyConnectedComponents(files, allEdges);
  const allCyclicComponentIndices = new Set(
    allComponents.flatMap((component, index) =>
      isCyclicComponent(component, allEdges) ? [index] : [],
    ),
  );
  const allCyclicFiles = new Set(
    allComponents.filter((_, index) => allCyclicComponentIndices.has(index)).flat(),
  );
  const { componentOf, components } = computeStronglyConnectedComponents(files, edges);
  const cyclicComponentIndices = new Set(
    components.flatMap((component, index) => (isCyclicComponent(component, edges) ? [index] : [])),
  );
  const cyclicComponents = components.filter((_, index) => cyclicComponentIndices.has(index));
  const exceptionKeys = new Set(
    exceptions.map((entry) => `${entry.rule}|${entry.importer}|${entry.imported}`),
  );
  const usedExceptions = new Set();
  const violations = [];

  function record(rule, description, importer, imported) {
    const key = `${rule}|src/${importer}|src/${imported}`;
    if (exceptionKeys.has(key)) {
      usedExceptions.add(key);
      return;
    }
    violations.push({
      rule,
      description,
      importer: `src/${importer}`,
      imported: `src/${imported}`,
    });
  }

  for (const file of files) {
    const component = componentOf.get(file);
    if (!cyclicComponentIndices.has(component)) continue;
    for (const imported of edges.get(file) ?? []) {
      if (componentOf.get(imported) !== component) continue;
      record(
        CYCLE_RULE_ID,
        "static value-import edge is part of a strongly connected component; break the cycle or add a temporary tracked exception",
        file,
        imported,
      );
    }
  }

  for (const file of files) {
    if (!isContractSurfacePath(file)) continue;
    const importerModule = topLevelModuleOf(file);
    // Layering uses the full static graph: type-only edges do not execute, but
    // they still couple a contract to implementation inside a cyclic graph.
    for (const imported of allEdges.get(file) ?? []) {
      if (topLevelModuleOf(imported) === importerModule) continue;
      if (isContractSurfacePath(imported)) continue;
      // Keep the accepted leaf exemption explicit in the rule, independent of
      // the graph's current shape and of the exception allowlist.
      if ((allEdges.get(imported)?.size ?? 0) === 0) continue;
      if (!allCyclicFiles.has(imported)) continue;
      record(
        CONTRACT_LAYERING_RULE_ID,
        `contract module imports src/${imported}, which is itself in an import cycle; contracts may import stable leaves instead`,
        file,
        imported,
      );
    }
  }

  return {
    violations,
    staleExceptions: exceptions
      .map((entry) => `${entry.rule}|${entry.importer}|${entry.imported}`)
      .filter((key) => !usedExceptions.has(key)),
    exceptions,
    cyclicComponents: cyclicComponents.map((component) => component.map((file) => `src/${file}`)),
    fullCyclicComponents: allComponents
      .filter((_, index) => allCyclicComponentIndices.has(index))
      .map((component) => component.map((file) => `src/${file}`)),
    largestStronglyConnectedComponentSize: allComponents.reduce(
      (largest, component) => Math.max(largest, component.length),
      0,
    ),
    largestValueCycleSize: cyclicComponents.reduce(
      (largest, component) => Math.max(largest, component.length),
      0,
    ),
  };
}

export function formatGraphGuardReport(result) {
  const lines = [];
  if (result.violations.length > 0) {
    lines.push("Import-cycle / contract-layering violations:");
    for (const violation of result.violations) {
      lines.push(`- [${violation.rule}] ${violation.importer} imports ${violation.imported}`);
      lines.push(`  ${violation.description}`);
    }
    lines.push(
      "Add a temporary entry to scripts/soft-deps-exceptions.json only when intentional; prefer breaking the cycle or importing a stable leaf.",
    );
  }
  if (result.staleExceptions.length > 0) {
    lines.push("Stale graph-guard exceptions (remove from scripts/soft-deps-exceptions.json):");
    for (const key of result.staleExceptions) lines.push(`- ${key}`);
  }
  return lines;
}

/**
 * Scan src/ for soft-dependency violations.
 * @param {{
 *   exceptions?: Array<{rule: string, importer: string, imported: string, reason?: string}>,
 *   srcRoot?: string,
 *   sourceGraph?: ReturnType<typeof scanSourceTree>,
 * }} [options]
 */
export function findSoftDependencyViolations(options = {}) {
  const ruleIds = new Set(RULES.map((rule) => rule.id));
  const exceptions = (options.exceptions ?? loadExceptions()).filter((entry) =>
    ruleIds.has(entry.rule),
  );
  const scanRoot = options.srcRoot ? resolve(options.srcRoot) : defaultSrcRoot;
  const sourceGraph = options.sourceGraph ?? scanSourceTree(scanRoot);
  const exceptionKeys = new Set(
    exceptions.map((entry) => `${entry.rule}|${entry.importer}|${entry.imported}`),
  );
  const usedExceptions = new Set();
  const violations = [];
  const edges = [];

  for (const importerRel of sourceGraph.files) {
    const fromPackage = classifyPackage(importerRel);
    if (!fromPackage) continue;

    for (const { imported: importedRel, spec } of sourceGraph.softImports.get(importerRel) ?? []) {
      const toPackage = classifyPackage(importedRel);
      if (!toPackage || toPackage === fromPackage) continue;

      edges.push({
        fromPackage,
        toPackage,
        importer: `src/${importerRel}`,
        imported: `src/${importedRel}`,
        spec,
      });

      for (const rule of RULES) {
        if (!rule.from.includes(fromPackage)) continue;
        if (!rule.forbid.includes(toPackage)) continue;

        const key = `${rule.id}|src/${importerRel}|src/${importedRel}`;
        if (exceptionKeys.has(key)) {
          usedExceptions.add(key);
          continue;
        }

        violations.push({
          rule: rule.id,
          description: rule.description,
          importer: `src/${importerRel}`,
          imported: `src/${importedRel}`,
          fromPackage,
          toPackage,
          spec,
        });
      }
    }
  }

  const staleExceptions = exceptions
    .map((entry) => `${entry.rule}|${entry.importer}|${entry.imported}`)
    .filter((key) => !usedExceptions.has(key));

  return { violations, edges, staleExceptions, exceptions };
}

export function formatSoftDependencyReport(result) {
  const lines = [];
  if (result.violations.length > 0) {
    lines.push("Soft package dependency violations:");
    for (const violation of result.violations) {
      lines.push(
        `- [${violation.rule}] ${violation.importer} imports ${violation.imported} (${violation.spec})`,
      );
      lines.push(`  ${violation.description}`);
    }
    lines.push(
      "Add a temporary entry to scripts/soft-deps-exceptions.json only when intentional; prefer restoring the seam.",
    );
  }
  if (result.staleExceptions.length > 0) {
    lines.push("Stale soft-dependency exceptions (remove from scripts/soft-deps-exceptions.json):");
    for (const key of result.staleExceptions) {
      lines.push(`- ${key}`);
    }
  }
  return lines;
}

function main() {
  // Build and evaluate the complete file graph before the legacy package-root
  // classification so files outside PACKAGE_ROOTS still participate in SCCs.
  const sourceGraph = scanSourceTree(defaultSrcRoot);
  const graphResult = findGraphGuardViolations({ sourceGraph });
  const result = findSoftDependencyViolations({ sourceGraph });
  const lines = [...formatGraphGuardReport(graphResult), ...formatSoftDependencyReport(result)];
  if (lines.length > 0) {
    for (const line of lines) console.error(line);
    process.exitCode = 1;
    return;
  }

  const autonomyAssessment = result.edges.filter(
    (edge) => edge.fromPackage === "autonomy" && ALLOWED_AUTONOMY_IMPORTS.includes(edge.toPackage),
  ).length;
  console.log(
    `Verified soft package dependencies (${RULES.length} rules, ${result.exceptions.length} exceptions, ${autonomyAssessment} allowed autonomy→assessment/roadmap edges).`,
  );
  console.log(
    `Verified import-cycle and contract-layering guards (full import-graph largest SCC ${graphResult.largestStronglyConnectedComponentSize} file(s), ${graphResult.cyclicComponents.length} value-import cycle(s), largest value-import cycle ${graphResult.largestValueCycleSize} file(s), ${graphResult.exceptions.length} baseline exceptions).`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
