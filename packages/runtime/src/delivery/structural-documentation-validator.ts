// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import type { DocumentationSourceApplicabilityV1 } from "../repository/documentation-source-applicability.js";
import {
  documentationMarkdownAnchors,
  documentationMarkdownLinkTargets,
  inspectDocumentationMdxCards,
  isBlockingDocumentationSourceLimitation,
  maskMarkdownLiteralContent,
  resolveDocumentationSourceAdapter,
} from "../repository/documentation-source-support.js";
import {
  fernRouteAliases,
  fernCanonicalTargets,
  fernHasVersionIndex,
  fernNavigationTargets,
  fernProjectionMappings,
  fernRoutePrefixes,
  fernVersionNavigationPaths,
  FernStructuralParseError,
  matchesFernProjectionPattern,
} from "./structural-documentation-routes.js";
import {
  MkdocsStructuralValidationIssue,
  validateMkdocsStructuralDocumentation,
} from "./structural-documentation-mkdocs.js";
import {
  DocusaurusStructuralParseError,
  docusaurusReachableDocumentPaths,
  parseDocusaurusLiteralModule,
  parseDocusaurusSidebars,
} from "../repository/documentation-source-docusaurus.js";
import {
  validateSphinxDocumentationRoot,
  SphinxStructuralParseError,
  type SphinxStructuralIssueCode,
} from "./structural-documentation-sphinx.js";

export const STRUCTURAL_DOCUMENTATION_CHECK_IDS = [
  "documentation-paths-readable",
  "documentation-relative-links",
  "fern-navigation-targets",
] as const;
export const SOURCE_AWARE_STRUCTURAL_DOCUMENTATION_CHECK_IDS = [
  "documentation-source-applicability",
  "documentation-paths-readable",
  "documentation-relative-links",
  "documentation-navigation-targets",
] as const;
export type DocumentationCheckId = (typeof STRUCTURAL_DOCUMENTATION_CHECK_IDS)[number];
export type SourceAwareDocumentationCheckId =
  (typeof SOURCE_AWARE_STRUCTURAL_DOCUMENTATION_CHECK_IDS)[number];
export type DocumentationCheckStatus = "passed" | "failed" | "limitation";
export type DocumentationCheckResult = Readonly<{
  id: DocumentationCheckId | SourceAwareDocumentationCheckId;
  status: DocumentationCheckStatus;
}>;
export type DocumentationChangedPath = Readonly<{
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "copied";
}>;

/** Stable, content-free reason for a host structural documentation rejection. */
export class StructuralDocumentationValidationError extends Error {
  public constructor(
    public readonly check: DocumentationCheckId | SourceAwareDocumentationCheckId,
    public readonly status: Exclude<DocumentationCheckStatus, "passed">,
    details = "",
  ) {
    super(
      `Structural documentation validation ${status} (${check})${details ? `: ${details}` : ""}.`,
    );
    this.name = "StructuralDocumentationValidationError";
  }
}

const MARKUP = /\.(?:md|mdx)$/u;
const REFERENCE_LINK = /!?(?:\[[^\]]+\])\[([^\]]*)\]/gu;
const REFERENCE_DEFINITION = /^\s{0,3}\[([^\]]+)\]:\s*(?:<([^>]+)>|(\S+))/gmu;
const NAVIGATION_PATH = /^fern\/(?:docs|versions\/[^/]+)\.ya?ml$/u;
const DOCUSAURUS_SIDEBARS_CONFIG = /(?:^|\/)sidebars\.(?:js|ts)$/u;
const DOCUSAURUS_MAIN_CONFIG = /(?:^|\/)docusaurus\.config\.(?:js|ts)$/u;

/** Validate a host-derived source root without manufacturing a Fern result. */
export async function validateSourceAwareStructuralDocumentation(
  candidateRoot: string,
  changedPaths: readonly (string | DocumentationChangedPath)[],
  applicability: DocumentationSourceApplicabilityV1,
): Promise<readonly DocumentationCheckResult[]> {
  const blocking = applicability.roots.flatMap((root) =>
    root.limitations.filter(isBlockingDocumentationSourceLimitation),
  );
  if (blocking.length > 0)
    // hygiene: ok -- the error class constructs the complete stable message.
    throw new StructuralDocumentationValidationError(
      "documentation-source-applicability",
      "limitation",
      blocking.join(", "),
    );
  if (
    applicability.roots.some(
      (root) =>
        !["plain-markdown", "fern", "mkdocs", "docusaurus", "sphinx", "jupyter-book"].includes(
          root.adapterId,
        ),
    )
  )
    // hygiene: ok -- the error class constructs the complete stable message.
    throw new StructuralDocumentationValidationError(
      "documentation-source-applicability",
      "limitation",
      "The selected source adapter is reserved but is not implemented.",
    );
  if (applicability.roots.length === 0)
    // hygiene: ok -- the error class constructs the complete stable message.
    throw new StructuralDocumentationValidationError(
      "documentation-source-applicability",
      "limitation",
      "Documentation validation requires a positive source applicability root.",
    );
  const normalized = changedPaths.map(normalizeChangedPath);
  const candidate = resolve(candidateRoot);
  for (const sourceRoot of applicability.roots) {
    const root = sourceRoot.root === "." ? candidate : resolve(candidate, sourceRoot.root);
    const localChanged = normalized
      .filter(({ path }) => documentationRootForPath(path) === sourceRoot.root)
      .map(({ path, status }) => ({ path: sourceRootPath(sourceRoot.root, path), status }));
    if (sourceRoot.adapterId === "fern") {
      if (sourceRoot.navigationMode !== "explicit")
        // hygiene: ok -- the error class constructs the complete stable message.
        throw new StructuralDocumentationValidationError(
          "documentation-source-applicability",
          "limitation",
          "Fern documentation requires explicit navigation applicability.",
        );
      const effective = new Map(localChanged.map((item) => [item.path, item]));
      for (const configuration of sourceRoot.configurationFiles) {
        const path = sourceRootPath(sourceRoot.root, configuration.path);
        if (!effective.has(path)) effective.set(path, { path, status: "modified" });
      }
      const historical = await validateStructuralDocumentation(root, [...effective.values()]);
      const byId = new Map(historical.map((result) => [result.id, result.status]));
      requiredStatus(byId, "documentation-paths-readable");
      requiredStatus(byId, "documentation-relative-links");
      requiredStatus(byId, "fern-navigation-targets");
      continue;
    }
    if (sourceRoot.adapterId === "mkdocs") {
      const configurationFiles = sourceRoot.configurationFiles.map((configuration) => ({
        path: sourceRootPath(sourceRoot.root, configuration.path),
      }));
      try {
        await validateMkdocsStructuralDocumentation(root, localChanged, configurationFiles);
      } catch (error) {
        if (error instanceof MkdocsStructuralValidationIssue)
          // hygiene: ok -- the error class constructs the complete stable message.
          throw new StructuralDocumentationValidationError(
            error.check,
            error.status,
            error.details,
          );
        throw error;
      }
      continue;
    }
    if (sourceRoot.adapterId === "docusaurus") {
      await validateDocusaurusSourceRoot(root, sourceRoot, localChanged);
      continue;
    }
    if (sourceRoot.adapterId === "sphinx") {
      if (sourceRoot.navigationMode !== "explicit")
        // hygiene: ok -- the error class constructs the complete stable message.
        throw new StructuralDocumentationValidationError(
          "documentation-source-applicability",
          "limitation",
          "Sphinx documentation requires explicit navigation applicability.",
        );
      try {
        await validateSphinxDocumentationRoot(
          root,
          sourceRoot.configurationFiles.map((file) => ({
            path: sourceRootPath(sourceRoot.root, file.path),
            sha256: file.sha256,
          })),
          localChanged,
        );
      } catch (error) {
        mapSphinxStructuralError(error);
      }
      continue;
    }
    // A fallback root runs the plain checks only while it records what they skip.
    const fallback = resolveDocumentationSourceAdapter(sourceRoot.adapterId).validationFallback;
    if (
      fallback
        ? !sourceRoot.limitations.includes(fallback.limitation)
        : sourceRoot.navigationMode !== "none"
    )
      // hygiene: ok -- the error class constructs the complete stable message.
      throw new StructuralDocumentationValidationError(
        "documentation-source-applicability",
        "limitation",
        fallback
          ? "Fallback documentation must record that its navigation was not checked."
          : "Plain documentation requires positive no-navigation applicability.",
      );
    for (const { path, status } of localChanged) {
      if (status === "deleted" || !MARKUP.test(path)) continue;
      const source = await readCandidateFile(root, path, "documentation-paths-readable");
      await validateMarkdownLinks(root, path, source, new Map());
    }
  }
  return Object.freeze(
    SOURCE_AWARE_STRUCTURAL_DOCUMENTATION_CHECK_IDS.map((id) => ({
      id,
      status: "passed" as const,
    })),
  );
}

/**
 * Requires every changed doc to be reachable from the sidebars and checks its
 * relative links. Absolute Docusaurus routes ("/docs/...") are not resolved.
 */
async function validateDocusaurusSourceRoot(
  root: string,
  sourceRoot: DocumentationSourceApplicabilityV1["roots"][number],
  localChanged: readonly DocumentationChangedPath[],
): Promise<void> {
  if (sourceRoot.navigationMode !== "explicit")
    // hygiene: ok -- the error class constructs the complete stable message.
    throw new StructuralDocumentationValidationError(
      "documentation-source-applicability",
      "limitation",
      "Docusaurus documentation requires explicit sidebar navigation applicability.",
    );
  for (const configuration of sourceRoot.configurationFiles) {
    if (!DOCUSAURUS_MAIN_CONFIG.test(configuration.path)) continue;
    const configPath = sourceRootPath(sourceRoot.root, configuration.path);
    const configSource = await readCandidateFile(root, configPath, "documentation-paths-readable");
    try {
      parseDocusaurusLiteralModule(configSource);
    } catch (error) {
      if (error instanceof DocusaurusStructuralParseError)
        // hygiene: ok -- the error class constructs the complete stable message.
        throw new StructuralDocumentationValidationError(
          "documentation-navigation-targets",
          "limitation",
          error.message,
        );
      throw error;
    }
  }
  const sidebarsFile = sourceRoot.configurationFiles.find((file) =>
    DOCUSAURUS_SIDEBARS_CONFIG.test(file.path),
  );
  if (!sidebarsFile)
    // hygiene: ok -- the error class constructs the complete stable message.
    throw new StructuralDocumentationValidationError(
      "documentation-navigation-targets",
      "limitation",
      "Docusaurus documentation requires a governing sidebars.js or sidebars.ts file.",
    );
  const sidebarsPath = sourceRootPath(sourceRoot.root, sidebarsFile.path);
  const sidebarsSource = await readCandidateFile(
    root,
    sidebarsPath,
    "documentation-paths-readable",
  );
  let sidebars: ReturnType<typeof parseDocusaurusSidebars>;
  try {
    sidebars = parseDocusaurusSidebars(sidebarsSource);
  } catch (error) {
    if (error instanceof DocusaurusStructuralParseError)
      // hygiene: ok -- the error class constructs the complete stable message.
      throw new StructuralDocumentationValidationError(
        "documentation-navigation-targets",
        "limitation",
        error.message,
      );
    throw error;
  }
  const reachable = await docusaurusReachableDocumentPaths(root, "docs", sidebars);
  // The skip below is safe: the applicability gate already refuses changed
  // markup outside "docs/" (adapterOwnsMarkupPath), so none reaches this arm.
  for (const { path, status } of localChanged) {
    if (status === "deleted" || !MARKUP.test(path) || !path.startsWith("docs/")) continue;
    const candidate = candidatePath(root, path);
    if (!reachable.has(candidate))
      // hygiene: ok -- the error class constructs the complete stable message.
      throw new StructuralDocumentationValidationError(
        "documentation-navigation-targets",
        "failed",
        `Changed Docusaurus document is not reachable from sidebars: ${path}.`,
      );
    const source = await readCandidateFile(root, path, "documentation-paths-readable");
    await validateMarkdownLinks(root, path, source, new Map());
  }
}

function documentationRootForPath(path: string): string {
  const parts = path.split("/");
  return parts[0] === "packages" && parts.length > 2 ? `packages/${parts[1]}` : ".";
}

function sourceRootPath(root: string, path: string): string {
  return root === "." ? path : path.slice(root.length + 1);
}

function requiredStatus(
  results: ReadonlyMap<string, DocumentationCheckStatus>,
  id: string,
): DocumentationCheckStatus {
  const status = results.get(id);
  if (status === undefined)
    // hygiene: ok -- the error class constructs the complete stable message.
    throw new StructuralDocumentationValidationError(
      "documentation-source-applicability",
      "failed",
      `Required structural result is missing: ${id}.`,
    );
  return status;
}

/** Validate only exact changed documentation inputs. Unsupported Fern shapes fail closed. */
export async function validateStructuralDocumentation(
  candidateRoot: string,
  changedPaths: readonly (string | DocumentationChangedPath)[],
): Promise<readonly DocumentationCheckResult[]> {
  const root = resolve(candidateRoot);
  const paths = changedPaths
    .map(normalizeChangedPath)
    .filter(({ status }) => status !== "deleted")
    .map(({ path }) => path);
  const markdown = paths.filter((path) => MARKUP.test(path));
  const navigation = paths.filter(isFernNavigationPath);
  for (const path of [...markdown, ...navigation])
    await readCandidateFile(root, path, "documentation-paths-readable");
  const { paths: navigationPaths, prefixes } = await collectNavigationPaths(
    root,
    markdown,
    navigation,
  );
  const routeMap = new Map<string, string>();
  for (const path of navigationPaths) {
    const source = await readCandidateFile(root, path, "documentation-paths-readable");
    if (parseFern(() => fernHasVersionIndex(source))) continue;
    const targets = parseFern(() => fernNavigationTargets(source));
    const aliases = await parseFernAsync(() =>
      fernRouteAliases(root, candidatePath(root, path), targets, prefixes),
    );
    if (aliases.conflicts.size > 0)
      // hygiene: ok
      throw new StructuralDocumentationValidationError(
        // hygiene: ok
        "documentation-relative-links",
        "failed",
        `Conflicting route aliases in ${path}: ${[...aliases.conflicts].join(", ")}.`,
      );
    for (const [route, target] of aliases.routes) {
      if (routeMap.has(route) && routeMap.get(route) !== target)
        // hygiene: ok
        // hygiene: ok
        // hygiene: ok
        throw new StructuralDocumentationValidationError(
          // hygiene: ok
          "documentation-relative-links",
          "failed",
          `Conflicting route alias across separate navigation files for route ${route}.`,
        ); // hygiene: ok
      const resolvedTarget = await resolveNavigationTarget(root, target);
      await assertSafeCandidatePath(root, resolvedTarget, "fern-navigation-targets");
      routeMap.set(route, resolvedTarget);
    }
  }
  for (const path of markdown) {
    const source = await readCandidateFile(root, path, "documentation-paths-readable");
    await validateMarkdownLinks(root, path, source, routeMap);
  }
  const reachable = new Set<string>();
  for (const path of navigationPaths) {
    const source = await readCandidateFile(root, path, "documentation-paths-readable");
    if (parseFern(() => fernHasVersionIndex(source))) continue;
    for (const target of parseFern(() => fernNavigationTargets(source))) {
      await assertRelativeTarget(root, path, target.path, "fern-navigation-targets");
      const navigationPath = candidatePath(root, path);
      const resolved = resolve(dirname(navigationPath), target.path);
      if ((await stat(resolved).catch(() => undefined))?.isDirectory())
        for (const page of await markdownFiles(resolved)) {
          await assertSafeCandidatePath(root, page, "fern-navigation-targets");
          reachable.add(page.replaceAll("\\", "/"));
        }
      const targetPath = await resolveNavigationTarget(root, resolved);
      reachable.add(targetPath.replaceAll("\\", "/"));
      const canonicalTargets = fernCanonicalTargets(
        await readCandidateFile(
          root,
          targetPath.replace(root + "/", ""),
          "documentation-paths-readable",
        ),
      ); // hygiene: ok
      for (const canonical of canonicalTargets) {
        await assertRelativeTarget(
          root,
          relative(root, targetPath),
          canonical,
          "fern-navigation-targets",
        );
        if (canonical.startsWith("/") || externalTarget(canonical))
          // hygiene: ok
          throw new StructuralDocumentationValidationError(
            "fern-navigation-targets",
            "failed",
            "Canonical projection targets must be relative repository files.",
          );
        const canonicalPath = resolve(dirname(targetPath), canonical);
        const normalizedCanonical = /\.(?:md|mdx)$/u.test(canonicalPath)
          ? canonicalPath
          : (await fileExists(`${canonicalPath}.md`))
            ? `${canonicalPath}.md`
            : `${canonicalPath}.mdx`;
        reachable.add(normalizedCanonical.replaceAll("\\", "/"));
      }
    }
  }
  const projectionMappings = await loadProjectionMappings(root);
  for (const path of markdown.filter(
    (value) => value.startsWith("docs/") || value.startsWith("fern/pages/"),
  )) {
    const candidate = candidatePath(root, path).replaceAll("\\", "/");
    if (navigationPaths.length > 0 && reachable.has(candidate)) continue;
    if (path.startsWith("docs/") && projectionMappings.length > 0) {
      const owners = projectionMappings.filter((mapping) =>
        mapping.canonicalPatterns.some((pattern) => matchesFernProjectionPattern(path, pattern)),
      );
      if (owners.length !== 1)
        // hygiene: ok
        throw new StructuralDocumentationValidationError(
          "fern-navigation-targets",
          "limitation",
          `Canonical path does not have one unambiguous Fern source-map owner: ${path}.`,
        );
      const projections = markdown.filter(
        (changed) =>
          changed.startsWith("fern/pages/") &&
          owners[0]?.fernPatterns.some((pattern) => matchesFernProjectionPattern(changed, pattern)),
      );
      if (
        projections.length > 0 &&
        projections.every((projection) =>
          reachable.has(candidatePath(root, projection).replaceAll("\\", "/")),
        )
      )
        continue;
      // hygiene: ok
      throw new StructuralDocumentationValidationError(
        "fern-navigation-targets",
        "limitation",
        `Canonical path lacks a changed, navigation-reachable Fern projection: ${path}.`,
      );
    }
    // hygiene: ok
    throw new StructuralDocumentationValidationError(
      "fern-navigation-targets",
      "failed",
      `Changed documentation path is not reachable from Fern navigation: ${path}.`,
    );
  }
  return STRUCTURAL_DOCUMENTATION_CHECK_IDS.map((id) => ({ id, status: "passed" }));
}
async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
async function markdownFiles(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await markdownFiles(path)));
    else if (/\.mdx?$/u.test(entry.name)) result.push(path);
  }
  return result;
}
async function resolveNavigationTarget(root: string, resolved: string): Promise<string> {
  if (await fileExists(resolved)) return resolved;
  const candidates = [
    join(resolved, "index.mdx"),
    join(resolved, "index.md"),
    join(resolved, "_index.md"),
  ];
  const existing = [] as string[];
  for (const candidate of candidates) if (await fileExists(candidate)) existing.push(candidate);
  if (existing.length !== 1)
    // hygiene: ok
    throw new StructuralDocumentationValidationError(
      // hygiene: ok
      "fern-navigation-targets",
      "failed",
      `Navigation target is not exactly one unique file: ${relative(root, resolved)}.`,
    ); // hygiene: ok
  return existing[0] ?? resolved;
}

async function validateMarkdownLinks(
  root: string,
  path: string,
  source: string,
  routeMap: ReadonlyMap<string, string>,
): Promise<void> {
  source = maskMarkdownLiteralContent(source);
  const definitions = new Map<string, string>();
  for (const match of source.matchAll(REFERENCE_DEFINITION)) {
    const label = match[1]?.trim().toLowerCase();
    const target = match[2] ?? match[3];
    if (!label || target === undefined) {
      // hygiene: ok
      throw new StructuralDocumentationValidationError(
        "documentation-relative-links",
        "limitation",
      );
    }
    definitions.set(label, target);
  }
  for (const match of source.matchAll(REFERENCE_LINK)) {
    const label = (match[1] ?? "").trim().toLowerCase();
    const target = definitions.get(label);
    if (target === undefined) {
      // hygiene: ok
      throw new StructuralDocumentationValidationError(
        "documentation-relative-links",
        "limitation",
      );
    }
  }
  for (const issue of inspectDocumentationMdxCards(source).issues) {
    const details =
      issue === "incomplete-opening-tag"
        ? "Card opening tags must be complete within the supported validation bound."
        : issue === "unsupported-attribute-expression"
          ? "Card attribute expressions are unsupported by structural documentation validation."
          : issue === "unsupported-expression-delimiter"
            ? "Card opening tags contain an unsupported attribute expression delimiter."
            : issue === "invalid-href-cardinality"
              ? "Each Card opening tag must contain exactly one supported href attribute."
              : "Card href attributes must use one non-empty static quoted target.";
    // hygiene: ok -- the error class constructs the complete stable message.
    throw new StructuralDocumentationValidationError(
      "documentation-relative-links",
      "limitation",
      details,
    );
  }
  for (const target of documentationMarkdownLinkTargets(source))
    await assertTarget(root, path, target, "documentation-relative-links", routeMap);
}

async function collectNavigationPaths(
  root: string,
  markdown: readonly string[],
  changedNavigation: readonly string[],
): Promise<{ paths: string[]; prefixes: string[] }> {
  const result: string[] = [];
  let prefixes = [""];
  const candidates = new Set(changedNavigation);
  if (markdown.some((path) => path.startsWith("docs/") || path.startsWith("fern/pages/")))
    for (const path of ["fern/docs.yml", "fern/docs.yaml"]) candidates.add(path);
  for (const path of [...candidates]) {
    try {
      await readCandidateFile(root, path, "documentation-paths-readable");
      result.push(path);
    } catch (error) {
      if (!(error instanceof StructuralDocumentationValidationError)) throw error;
    }
  }
  for (const path of [...result]) {
    if (!path.endsWith("/docs.yml") && !path.endsWith("/docs.yaml")) continue;
    const source = await readCandidateFile(root, path, "documentation-paths-readable");
    if (path.endsWith("/docs.yml") || path.endsWith("/docs.yaml"))
      prefixes = parseFern(() => fernRoutePrefixes(source));
    for (const nested of parseFern(() =>
      fernVersionNavigationPaths(candidatePath(root, path), source),
    )) {
      const relativePath = relative(root, nested).replaceAll("\\", "/");
      candidatePath(root, relativePath);
      if (!NAVIGATION_PATH.test(relativePath))
        // hygiene: ok
        throw new StructuralDocumentationValidationError(
          "fern-navigation-targets",
          "limitation",
          `Unsupported Fern version navigation path: ${relativePath}.`,
        );
      result.push(relativePath);
    }
  }
  if (!result.some((path) => path.endsWith("/docs.yml") || path.endsWith("/docs.yaml"))) {
    try {
      const versions = await readdir(join(root, "fern", "versions"), { withFileTypes: true });
      for (const entry of versions) {
        const path = `fern/versions/${entry.name}`;
        if (entry.isFile() && NAVIGATION_PATH.test(path)) result.push(path);
      }
    } catch {
      // Versioned navigation is optional.
    }
  }
  return { paths: [...new Set(result)], prefixes };
}

function normalizeChangedPath(value: string | DocumentationChangedPath): DocumentationChangedPath {
  const path = typeof value === "string" ? value : value.path;
  const status = typeof value === "string" ? "modified" : value.status;
  if (
    status !== "added" &&
    status !== "modified" &&
    status !== "deleted" &&
    status !== "renamed" &&
    status !== "copied"
  )
    throw new StructuralDocumentationValidationError("documentation-paths-readable", "failed"); // hygiene: ok
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => part === ".." || part === "")
  )
    throw new StructuralDocumentationValidationError("documentation-paths-readable", "failed"); // hygiene: ok
  return { path, status };
}
function isFernNavigationPath(path: string): boolean {
  return NAVIGATION_PATH.test(path);
}
function externalTarget(target: string): boolean {
  return /^(?:https?:|mailto:|tel:|#)/iu.test(target);
}

function parseFern<T>(action: () => T): T {
  try {
    return action();
  } catch (error) {
    if (error instanceof FernStructuralParseError)
      // hygiene: ok
      throw new StructuralDocumentationValidationError(
        "fern-navigation-targets",
        "limitation",
        error.message,
      );
    throw error;
  }
}

async function parseFernAsync<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof FernStructuralParseError)
      // hygiene: ok
      throw new StructuralDocumentationValidationError(
        "fern-navigation-targets",
        "limitation",
        error.message,
      );
    throw error;
  }
}

async function loadProjectionMappings(root: string) {
  const path = "fern/SOURCE_MAP.md";
  const absolute = candidatePath(root, path);
  try {
    await lstat(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    // hygiene: ok
    throw new StructuralDocumentationValidationError("documentation-paths-readable", "failed");
  }
  const source = await readCandidateFile(root, path, "documentation-paths-readable");
  return parseFern(() => fernProjectionMappings(source));
}
async function readCandidateFile(
  root: string,
  path: string,
  check: DocumentationCheckId,
): Promise<string> {
  try {
    const candidate = candidatePath(root, path);
    await assertSafeCandidatePath(root, candidate, check);
    return await readFile(candidate, "utf8");
  } catch {
    throw new StructuralDocumentationValidationError(check, "failed");
  }
}
async function assertRelativeTarget(
  root: string,
  sourcePath: string,
  rawTarget: string,
  check: DocumentationCheckId,
): Promise<void> {
  const { target, fragment } = documentationTarget(rawTarget);
  if (externalTarget(target)) return;
  if (!target) {
    if (fragment)
      await assertDocumentationAnchor(root, candidatePath(root, sourcePath), fragment, check);
    return;
  }
  if (target.includes("\\") || target.startsWith("/"))
    throw new StructuralDocumentationValidationError(check, "failed");
  const resolved = resolve(dirname(candidatePath(root, sourcePath)), target);
  if (!within(root, resolved)) throw new StructuralDocumentationValidationError(check, "failed");
  const candidates = /\.(?:md|mdx)$/u.test(resolved)
    ? [resolved]
    : [
        resolved,
        `${resolved}.md`,
        `${resolved}.mdx`,
        join(resolved, "index.mdx"),
        join(resolved, "index.md"),
        join(resolved, "_index.md"),
      ];
  for (const candidate of candidates)
    try {
      await assertSafeCandidatePath(root, candidate, check);
      if ((await stat(candidate)).isFile()) {
        if (fragment) await assertDocumentationAnchor(root, candidate, fragment, check);
        return;
      }
    } catch {
      /* next candidate */
    }
  throw new StructuralDocumentationValidationError(check, "failed");
}
async function assertTarget(
  root: string,
  sourcePath: string,
  rawTarget: string,
  check: DocumentationCheckId,
  routeMap: ReadonlyMap<string, string>,
): Promise<void> {
  const { target, fragment } = documentationTarget(rawTarget);
  if (target.startsWith("/")) {
    const mapped = routeMap.get(target);
    if (!mapped) throw new StructuralDocumentationValidationError(check, "failed");
    await assertSafeCandidatePath(root, mapped, check);
    if (!(await stat(mapped)).isFile())
      throw new StructuralDocumentationValidationError(check, "failed");
    if (fragment) await assertDocumentationAnchor(root, mapped, fragment, check);
    return;
  }
  await assertRelativeTarget(root, sourcePath, rawTarget, check);
}

function documentationTarget(rawTarget: string): { target: string; fragment?: string } {
  const separator = rawTarget.indexOf("#");
  if (separator < 0) return { target: rawTarget };
  return { target: rawTarget.slice(0, separator), fragment: rawTarget.slice(separator + 1) };
}

async function assertDocumentationAnchor(
  root: string,
  path: string,
  rawFragment: string,
  check: DocumentationCheckId,
): Promise<void> {
  await assertSafeCandidatePath(root, path, check);
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawFragment);
  } catch {
    throw new StructuralDocumentationValidationError(check, "failed");
  }
  const anchors = documentationMarkdownAnchors(await readFile(path, "utf8"));
  const literal = decoded.normalize("NFC");
  if (!literal || !anchors.includes(literal))
    throw new StructuralDocumentationValidationError(check, "failed");
}
function candidatePath(root: string, path: string): string {
  const value = resolve(root, path);
  if (!within(root, value))
    throw new StructuralDocumentationValidationError("documentation-paths-readable", "failed"); // hygiene: ok
  return value;
}
async function assertSafeCandidatePath(
  root: string,
  value: string,
  check: DocumentationCheckId,
): Promise<void> {
  if (!within(root, value)) throw new StructuralDocumentationValidationError(check, "failed");
  let current = root;
  const segments = relative(root, value).split(/[\\/]/u).filter(Boolean);
  try {
    if ((await lstat(current)).isSymbolicLink())
      throw new StructuralDocumentationValidationError(check, "failed");
    for (const segment of segments) {
      current = join(current, segment);
      if ((await lstat(current)).isSymbolicLink())
        throw new StructuralDocumentationValidationError(check, "failed");
    }
    const rootReal = await realpath(root);
    const valueReal = await realpath(value);
    if (!within(rootReal, valueReal))
      throw new StructuralDocumentationValidationError(check, "failed");
  } catch (error) {
    if (error instanceof StructuralDocumentationValidationError) throw error;
    throw new StructuralDocumentationValidationError(check, "failed");
  }
}
function within(root: string, value: string): boolean {
  const result = relative(root, value);
  return (
    result === "" ||
    (!result.startsWith("..") && !result.includes("..\\") && !result.includes("../"))
  );
}

/** Translate a Sphinx-adapter-specific parse issue into the shared source-aware result shape. */
function mapSphinxStructuralError(error: unknown): never {
  if (error instanceof SphinxStructuralParseError) {
    const mapping: Record<
      SphinxStructuralIssueCode,
      {
        check: DocumentationCheckId | SourceAwareDocumentationCheckId;
        status: Exclude<DocumentationCheckStatus, "passed">;
      }
    > = {
      "ambiguous-configuration-location": {
        check: "documentation-source-applicability",
        status: "limitation",
      },
      "ambiguous-configuration-value": {
        check: "documentation-source-applicability",
        status: "limitation",
      },
      "computed-configuration": {
        check: "documentation-source-applicability",
        status: "limitation",
      },
      "unsupported-directive": {
        check: "documentation-source-applicability",
        status: "limitation",
      },
      "malformed-directive": { check: "documentation-navigation-targets", status: "failed" },
      "missing-target": { check: "documentation-navigation-targets", status: "failed" },
      "path-escape": { check: "documentation-navigation-targets", status: "failed" },
      cycle: { check: "documentation-navigation-targets", status: "failed" },
      "generated-content-target": {
        check: "documentation-navigation-targets",
        status: "limitation",
      },
      "duplicate-reference-label": { check: "documentation-relative-links", status: "failed" },
    };
    const mapped = mapping[error.code];
    // hygiene: ok -- the error class constructs the complete stable message.
    throw new StructuralDocumentationValidationError(mapped.check, mapped.status, error.message);
  }
  throw error;
}
