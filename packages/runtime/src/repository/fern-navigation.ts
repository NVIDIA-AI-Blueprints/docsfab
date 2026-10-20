// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { posix, win32 } from "node:path";

import { parseDocument, visit } from "yaml";

import { canonicalDigest, sha256 as sha256Bytes } from "../content-ir/canonical.js";
import { readTrackedRepositoryFile } from "./workspace/tracked-read.js";
import {
  RepositoryWorkspaceReadError,
  type RepositoryWorkspace,
  type TrackedRepositoryEntry,
} from "./workspace/contracts.js";
import { isRecord, compareText } from "../shared/primitives.js";

const FERN_INDEX_PATH = "fern/docs.yml";
const PARSER_ROOT = "/__docsfab_repository__";
const MAX_FERN_SOURCES = 32;
const MAX_FERN_SOURCE_BYTES = 1024 * 1024;
const MAX_FERN_SOURCE_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_FERN_TARGETS = 10_000;
const MAX_FERN_TARGET_BYTES = 8 * 1024 * 1024;
const MAX_FERN_TARGET_TOTAL_BYTES = 64 * 1024 * 1024;

export class FernStructuralParseError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "FernStructuralParseError";
  }
}

type UnknownRecord = Record<string, unknown>;

export type FernNavigationTarget = Readonly<{
  path: string;
  routeSegments?: readonly string[];
  folder: boolean;
}>;

export type FernNavigationObservationFailureCode =
  | "source-missing"
  | "source-unsafe"
  | "source-too-large"
  | "source-changed"
  | "source-unreadable"
  | "source-budget-exceeded"
  | "malformed-navigation"
  | "unsafe-navigation-path"
  | "target-missing"
  | "target-unsafe"
  | "target-too-large"
  | "target-changed"
  | "target-unreadable"
  | "target-budget-exceeded"
  | "conflicting-route";

export interface FernNavigationObservationFailureV1 {
  code: FernNavigationObservationFailureCode;
  path: string;
  evidenceSha256: string;
}

export interface FernNavigationObservationSourceV1 {
  path: string;
  contentSha256: string;
  evidenceSha256: string;
}

export interface FernNavigationObservationRouteV1 {
  sourcePath: string;
  path: string;
  route: string;
  sourceSha256: string;
  targetSha256: string;
  evidenceSha256: string;
}

export type FernNavigationAdapter = "fern-yaml-v1" | "fern-versioned-yaml-v1";

export interface FernNavigationObservationV1 {
  schemaVersion: 1;
  kind: "docsfab-fern-navigation-observation";
  adapter: FernNavigationAdapter;
  repositoryRevision: string;
  status: "complete" | "incomplete";
  sources: FernNavigationObservationSourceV1[];
  routes: FernNavigationObservationRouteV1[];
  failures: FernNavigationObservationFailureV1[];
  evidenceSha256: string;
}

/** Extract version navigation references from the repository-owned Fern index. */
export function fernVersionNavigationPaths(sourcePath: string, source: string): string[] {
  const document = parseFernYaml(source);
  if (document.versions === undefined) return [];
  if (!Array.isArray(document.versions) || document.versions.length === 0)
    throw new FernStructuralParseError("Fern versions must contain at least one navigation entry.");
  const paths: string[] = [];
  for (const version of document.versions) {
    if (!isRecord(version) || typeof version.path !== "string")
      throw new FernStructuralParseError("Each Fern version must declare one scalar path.");
    const path = version.path.trim();
    assertRepositoryRelativePath(path, "Fern version path");
    if (!/\.ya?ml$/u.test(path))
      throw new FernStructuralParseError(
        "Fern version paths must reference repository YAML navigation files.",
      );
    const pathApi =
      sourcePath.includes("\\") || /^[A-Za-z]:[\\/]/u.test(sourcePath) ? win32 : posix;
    paths.push(pathApi.resolve(pathApi.dirname(sourcePath), path));
  }
  return [...new Set(paths)];
}

export function fernHasVersionIndex(source: string): boolean {
  const document = parseFernYaml(source);
  if (document.versions !== undefined && document.navigation !== undefined)
    throw new FernStructuralParseError(
      "A Fern file cannot be both a version index and a navigation document.",
    );
  return document.versions !== undefined;
}

/** Read configured Fern instance route prefixes from the repository-owned index. */
export function fernRoutePrefixes(source: string): string[] {
  const document = parseFernYaml(source);
  if (document.instances === undefined) return [""];
  if (!Array.isArray(document.instances) || document.instances.length === 0)
    throw new FernStructuralParseError(
      "Fern instances must contain at least one configured route prefix.",
    );
  const prefixes: string[] = [];
  for (const instance of document.instances) {
    if (!isRecord(instance))
      throw new FernStructuralParseError(
        "Each Fern instance entry must use a supported mapping shape.",
      );
    const value = instance.url ?? instance.instance;
    if (typeof value !== "string" || value.trim() === "")
      throw new FernStructuralParseError("Each Fern instance must declare a scalar URL or name.");
    prefixes.push(instancePrefix(value));
  }
  return [...new Set(prefixes)];
}

/** Extract page and directory targets from supported Fern navigation shapes. */
export function fernNavigationTargets(source: string): FernNavigationTarget[] {
  const document = parseFernYaml(source);
  if (!Array.isArray(document.navigation))
    throw new FernStructuralParseError("Fern navigation must use a sequence of supported entries.");
  const targets: FernNavigationTarget[] = [];
  visitNavigationNodes(document.navigation, targets, [], tabRouteSlugs(document), {
    count: 0,
  });
  if (targets.length === 0)
    throw new FernStructuralParseError(
      "Fern navigation must contain at least one supported page target.",
    );
  return targets;
}

/**
 * Read a Fern navigation document or version index and its targets through the tracked
 * workspace. Only exact source names select this adapter, never repository or model prose.
 */
export async function observeFernNavigation(input: {
  workspace: RepositoryWorkspace;
  entries: readonly TrackedRepositoryEntry[];
}): Promise<FernNavigationObservationV1 | undefined> {
  const entryByPath = new Map(
    input.entries.flatMap((entry) => (entry.path ? [[entry.path, entry] as const] : [])),
  );
  const indexEntry = entryByPath.get(FERN_INDEX_PATH);
  if (!indexEntry) return undefined;

  const sources: FernNavigationObservationSourceV1[] = [];
  const routes: FernNavigationObservationRouteV1[] = [];
  const failures: FernNavigationObservationFailureV1[] = [];
  let sourceBytes = 0;
  let targetBytes = 0;
  let adapter: FernNavigationAdapter = "fern-versioned-yaml-v1";

  const readSource = async (
    path: string,
  ): Promise<{ text: string; sha256: string } | undefined> => {
    const entry = entryByPath.get(path);
    if (!entry) {
      failures.push(observationFailure("source-missing", path, input.workspace.revision));
      return undefined;
    }
    if (entry.kind !== "regular" || entry.byteLength === undefined) {
      failures.push(observationFailure("source-unsafe", path, input.workspace.revision));
      return undefined;
    }
    if (entry.byteLength > MAX_FERN_SOURCE_BYTES) {
      failures.push(observationFailure("source-too-large", path, input.workspace.revision));
      return undefined;
    }
    if (sourceBytes + entry.byteLength > MAX_FERN_SOURCE_TOTAL_BYTES) {
      failures.push(observationFailure("source-budget-exceeded", path, input.workspace.revision));
      return undefined;
    }
    try {
      const bytes = await readTrackedRepositoryFile(input.workspace, path, MAX_FERN_SOURCE_BYTES);
      const text = strictUtf8(bytes);
      const sha256 = sha256Bytes(bytes);
      sourceBytes += bytes.byteLength;
      const body = { path, contentSha256: sha256 };
      sources.push({ ...body, evidenceSha256: canonicalDigest(body) });
      return { text, sha256 };
    } catch (error) {
      failures.push(observationReadFailure(error, path, input.workspace.revision, "source"));
      return undefined;
    }
  };

  const index = await readSource(FERN_INDEX_PATH);
  if (index) {
    try {
      const versioned = fernHasVersionIndex(index.text);
      if (!versioned) adapter = "fern-yaml-v1";
      const prefixes = fernRoutePrefixes(index.text);
      const versionPaths = versioned
        ? fernVersionNavigationPaths(`${PARSER_ROOT}/${FERN_INDEX_PATH}`, index.text).map(
            parserPathToRepositoryPath,
          )
        : [FERN_INDEX_PATH];
      if (versionPaths.length > MAX_FERN_SOURCES) {
        failures.push(
          observationFailure("source-budget-exceeded", FERN_INDEX_PATH, input.workspace.revision),
        );
      } else {
        for (const versionPath of versionPaths.sort(compareText)) {
          // An unversioned index is the navigation source; reuse its bytes, not a second read.
          const version = versioned ? await readSource(versionPath) : index;
          if (!version) continue;
          let targets: FernNavigationTarget[];
          try {
            targets = fernNavigationTargets(version.text);
          } catch (error) {
            failures.push(parseFailure(error, versionPath, input.workspace.revision));
            continue;
          }
          const expanded = expandTargets(
            targets,
            versionPath,
            entryByPath,
            failures,
            input.workspace.revision,
          );
          if (routes.length + expanded.length * prefixes.length > MAX_FERN_TARGETS) {
            failures.push(
              observationFailure("target-budget-exceeded", versionPath, input.workspace.revision),
            );
            continue;
          }
          for (const target of expanded) {
            const entry = entryByPath.get(target.path);
            if (!entry || entry.kind !== "regular" || entry.byteLength === undefined) continue;
            if (entry.byteLength > MAX_FERN_TARGET_BYTES) {
              failures.push(
                observationFailure("target-too-large", target.path, input.workspace.revision),
              );
              continue;
            }
            if (targetBytes + entry.byteLength > MAX_FERN_TARGET_TOTAL_BYTES) {
              failures.push(
                observationFailure("target-budget-exceeded", target.path, input.workspace.revision),
              );
              continue;
            }
            let targetSha256: string;
            try {
              const bytes = await readTrackedRepositoryFile(
                input.workspace,
                target.path,
                MAX_FERN_TARGET_BYTES,
              );
              targetBytes += bytes.byteLength;
              targetSha256 = sha256Bytes(bytes);
            } catch (error) {
              failures.push(
                observationReadFailure(error, target.path, input.workspace.revision, "target"),
              );
              continue;
            }
            for (const prefix of prefixes) {
              const route = fernTargetRoute(prefix, target);
              const body = {
                sourcePath: versionPath,
                path: target.path,
                route,
                sourceSha256: version.sha256,
                targetSha256,
              };
              routes.push({ ...body, evidenceSha256: canonicalDigest(body) });
            }
          }
        }
      }
    } catch (error) {
      failures.push(parseFailure(error, FERN_INDEX_PATH, input.workspace.revision));
    }
  }

  const routeOwners = new Map<string, string>();
  for (const item of routes) {
    const previous = routeOwners.get(item.route);
    if (previous && previous !== item.path) {
      failures.push(observationFailure("conflicting-route", item.sourcePath, item.route));
    } else {
      routeOwners.set(item.route, item.path);
    }
  }
  const normalizedSources = uniqueBy(sources, (item) => item.path).sort((left, right) =>
    compareText(left.path, right.path),
  );
  const normalizedRoutes = uniqueBy(routes, (item) => `${item.route}\0${item.path}`).sort(
    (left, right) => compareText(left.route, right.route) || compareText(left.path, right.path),
  );
  const normalizedFailures = uniqueBy(failures, (item) => item.evidenceSha256).sort((left, right) =>
    compareText(`${left.code}\0${left.path}`, `${right.code}\0${right.path}`),
  );
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-fern-navigation-observation" as const,
    adapter,
    repositoryRevision: input.workspace.revision,
    status: normalizedFailures.length === 0 ? ("complete" as const) : ("incomplete" as const),
    sources: normalizedSources,
    routes: normalizedRoutes,
    failures: normalizedFailures,
  };
  return { ...body, evidenceSha256: canonicalDigest(body) };
}

function parseFernYaml(source: string): UnknownRecord {
  try {
    const document = parseDocument(source, { strict: true, uniqueKeys: true });
    if (document.errors.length > 0 || document.warnings.length > 0)
      throw new FernStructuralParseError(
        "Fern YAML contains malformed or unsupported syntax and cannot be interpreted.",
      );
    let hasAlias = false;
    visit(document, {
      Alias: () => {
        hasAlias = true;
        return visit.BREAK;
      },
    });
    if (hasAlias)
      throw new FernStructuralParseError(
        "Fern YAML aliases are unsupported by structural route validation.",
      );
    const value: unknown = document.toJS({ maxAliasCount: 0 });
    if (!isRecord(value))
      throw new FernStructuralParseError("Fern YAML must use a mapping at the document root.");
    return value;
  } catch (error) {
    if (error instanceof FernStructuralParseError) throw error;
    throw new FernStructuralParseError(
      "Fern YAML contains malformed or unsupported syntax and cannot be interpreted.",
    );
  }
}

function visitNavigationNodes(
  nodes: readonly unknown[],
  targets: FernNavigationTarget[],
  parentRoute: readonly string[],
  tabs: ReadonlyMap<string, string>,
  state: { count: number },
  depth = 0,
): void {
  if (depth > 64)
    throw new FernStructuralParseError(
      "Fern navigation nesting exceeds the maximum supported validation depth.",
    );
  for (const node of nodes) {
    state.count += 1;
    if (state.count > MAX_FERN_TARGETS)
      throw new FernStructuralParseError(
        "Fern navigation exceeds the maximum supported validation entry count.",
      );
    if (!isRecord(node))
      throw new FernStructuralParseError(
        "Fern navigation entries must use supported mapping shapes.",
      );
    let route = [...parentRoute];
    if (node.tab !== undefined) {
      if (typeof node.tab !== "string" || !tabs.has(node.tab))
        throw new FernStructuralParseError("Fern tab entries must reference a declared tab slug.");
      route = appendRouteSlug(route, tabs.get(node.tab));
    }
    if (node.section !== undefined && node.slug !== undefined)
      route = appendRouteSlug(route, routeSlug(node.slug, "Fern section slug"));
    const page = node.page;
    if (page !== undefined && node.folder !== undefined)
      throw new FernStructuralParseError(
        "Fern navigation entries cannot be both pages and folders.",
      );
    let hasTarget = false;
    if (page !== undefined) {
      if (typeof page !== "string" || page.trim() === "")
        throw new FernStructuralParseError("Fern page values must use non-empty scalar strings.");
      const path = looksLikePath(page) && node.path === undefined ? page : node.path;
      if (typeof path !== "string" || path.trim() === "")
        throw new FernStructuralParseError("Named Fern pages must declare a scalar path.");
      const normalized = path.trim();
      assertRepositoryRelativePath(normalized, "Fern page path");
      targets.push({
        path: normalized,
        routeSegments:
          node.slug !== undefined
            ? appendRouteSlug(route, routeSlug(node.slug, "Fern page slug"))
            : route.length > 0
              ? appendRouteSlug(route, pageSlugFromPath(normalized))
              : undefined,
        folder: false,
      });
      hasTarget = true;
    }
    if (node.folder !== undefined) {
      if (typeof node.folder !== "string" || node.folder.trim() === "")
        throw new FernStructuralParseError("Fern folder values must use non-empty scalar strings.");
      const normalized = node.folder.trim();
      assertRepositoryRelativePath(normalized, "Fern folder path");
      targets.push({
        path: normalized,
        routeSegments:
          node.slug !== undefined
            ? appendRouteSlug(route, routeSlug(node.slug, "Fern folder slug"))
            : route.length > 0
              ? appendRouteSlug(route, pageSlugFromPath(normalized))
              : undefined,
        folder: true,
      });
      hasTarget = true;
    }
    let hasChildren = false;
    for (const childKey of ["contents", "layout"] as const) {
      const children = node[childKey];
      if (children !== undefined) {
        if (hasTarget)
          throw new FernStructuralParseError(
            "Fern page and folder targets cannot also contain nested navigation.",
          );
        if (!Array.isArray(children))
          throw new FernStructuralParseError(
            `Fern ${childKey} must use a sequence of navigation entries.`,
          );
        visitNavigationNodes(children, targets, route, tabs, state, depth + 1);
        hasChildren = true;
      }
    }
    if (!hasTarget && !hasChildren)
      throw new FernStructuralParseError(
        "Fern navigation contains an entry shape unsupported by structural validation.",
      );
  }
}

function instancePrefix(value: string): string {
  const trimmed = value.trim();
  if (/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(trimmed)) return `/${trimmed}`;
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    if (!/^https?:$/u.test(url.protocol) || !url.hostname || url.username || url.password)
      throw new Error("The Fern instance URL uses an unsupported protocol or authority.");
    const pathname = url.pathname.replace(/\/+$/u, "");
    return pathname === "" ? "" : pathname;
  } catch {
    throw new FernStructuralParseError("Fern instance URL or name is malformed or unsupported.");
  }
}

function tabRouteSlugs(document: UnknownRecord): ReadonlyMap<string, string> {
  if (document.tabs === undefined) return new Map();
  if (!isRecord(document.tabs))
    throw new FernStructuralParseError("Fern tabs must use a mapping of named definitions.");
  const result = new Map<string, string>();
  for (const [name, definition] of Object.entries(document.tabs)) {
    if (!isRecord(definition) || definition.slug === undefined)
      throw new FernStructuralParseError("Each supported Fern tab must declare a scalar slug.");
    result.set(name, routeSlug(definition.slug, "Fern tab slug"));
  }
  return result;
}

function routeSlug(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9][A-Za-z0-9_-]*)?$/u.test(value.trim()))
    throw new FernStructuralParseError(`${field} must use one supported scalar route segment.`);
  return value.trim();
}

function appendRouteSlug(route: readonly string[], slug: string | undefined): string[] {
  return slug ? [...route, slug] : [...route];
}

function pageSlugFromPath(path: string): string {
  const name =
    path
      .split("/")
      .at(-1)
      ?.replace(/\.mdx?$/u, "") ?? "";
  return name === "index" || name === "_index" ? "" : routeSlug(name, "Fern path slug");
}

function assertRepositoryRelativePath(path: string, field: string): void {
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => part === "") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(path)
  )
    throw new FernStructuralParseError(
      `${field} must stay within one supported repository-relative path.`,
    );
}

function looksLikePath(value: string): boolean {
  return value.startsWith(".") || /\.mdx?$/u.test(value);
}

interface ExpandedTarget {
  path: string;
  routeSegments?: readonly string[];
  folderRoot?: string;
}

function expandTargets(
  targets: readonly FernNavigationTarget[],
  sourcePath: string,
  entryByPath: ReadonlyMap<string, TrackedRepositoryEntry>,
  failures: FernNavigationObservationFailureV1[],
  revision: string,
): ExpandedTarget[] {
  const expanded: ExpandedTarget[] = [];
  for (const target of targets) {
    let path: string;
    try {
      path = parserPathToRepositoryPath(
        posix.resolve(posix.dirname(`${PARSER_ROOT}/${sourcePath}`), target.path),
      );
    } catch {
      failures.push(observationFailure("unsafe-navigation-path", sourcePath, target.path));
      continue;
    }
    const entry = entryByPath.get(path);
    if (target.folder) {
      if (entry && entry.kind !== "regular") {
        failures.push(observationFailure("target-unsafe", path, revision));
        continue;
      }
      const descendants = [...entryByPath]
        .filter(
          ([candidate, value]) =>
            candidate.startsWith(`${path}/`) &&
            value.kind === "regular" &&
            /\.mdx?$/iu.test(candidate),
        )
        .map(([candidate]) => candidate)
        .sort(compareText);
      if (descendants.length === 0) {
        failures.push(observationFailure("target-missing", path, revision));
        continue;
      }
      expanded.push(
        ...descendants.map((candidate) => ({
          path: candidate,
          ...(target.routeSegments ? { routeSegments: target.routeSegments } : {}),
          folderRoot: path,
        })),
      );
      continue;
    }
    if (!entry) {
      failures.push(observationFailure("target-missing", path, revision));
      continue;
    }
    if (entry.kind !== "regular") {
      failures.push(observationFailure("target-unsafe", path, revision));
      continue;
    }
    expanded.push({
      path,
      ...(target.routeSegments ? { routeSegments: target.routeSegments } : {}),
    });
  }
  return expanded;
}

function fernTargetRoute(prefix: string, target: ExpandedTarget): string {
  let page: string;
  if (target.routeSegments) {
    const suffix = target.folderRoot
      ? posix
          .relative(target.folderRoot, target.path)
          .replace(/(?:^|\/)(?:_)?index\.mdx?$/u, "")
          .replace(/\.mdx?$/u, "")
          .split("/")
          .filter(Boolean)
          .map((segment) => routeSlug(segment, "Fern folder descendant route"))
      : [];
    page = [...target.routeSegments, ...suffix].filter(Boolean).join("/");
  } else {
    page = target.path
      .replace(/^(?:docs|fern\/pages)\//u, "")
      .replace(/(?:\/(?:_)?index)?\.mdx?$/u, "");
  }
  const routePage = page.startsWith(`${prefix.slice(1)}/`) ? page.slice(prefix.length) : page;
  return `${prefix}/${routePage}`.replaceAll("//", "/");
}

function parserPathToRepositoryPath(path: string): string {
  const prefix = `${PARSER_ROOT}/`;
  const normalized = posix.normalize(path);
  if (!normalized.startsWith(prefix))
    throw new FernStructuralParseError(
      "Fern navigation path escapes the governed repository workspace boundary.",
    );
  const relativePath = normalized.slice(prefix.length);
  if (
    !relativePath ||
    relativePath.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new FernStructuralParseError(
      "Fern navigation path uses an unsafe or unsupported repository form.",
    );
  return relativePath;
}

function strictUtf8(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new FernStructuralParseError("Fern navigation source is not valid governed UTF-8 text.");
  }
}

function parseFailure(
  error: unknown,
  path: string,
  revision: string,
): FernNavigationObservationFailureV1 {
  return observationFailure(
    error instanceof FernStructuralParseError && /escapes|within one supported/u.test(error.message)
      ? "unsafe-navigation-path"
      : "malformed-navigation",
    path,
    error instanceof Error ? error.message : revision,
  );
}

function observationReadFailure(
  error: unknown,
  path: string,
  revision: string,
  kind: "source" | "target",
): FernNavigationObservationFailureV1 {
  if (error instanceof FernStructuralParseError)
    return observationFailure("malformed-navigation", path, error.message);
  const prefix = kind === "source" ? "source" : "target";
  if (error instanceof RepositoryWorkspaceReadError) {
    if (error.code === "not-tracked")
      return observationFailure(`${prefix}-missing`, path, revision);
    if (error.code === "unsafe-kind") return observationFailure(`${prefix}-unsafe`, path, revision);
    if (error.code === "oversize") return observationFailure(`${prefix}-too-large`, path, revision);
    if (error.code === "changed") return observationFailure(`${prefix}-changed`, path, revision);
  }
  return observationFailure(`${prefix}-unreadable`, path, revision);
}

function observationFailure(
  code: FernNavigationObservationFailureCode,
  path: string,
  detail: string,
): FernNavigationObservationFailureV1 {
  const body = { code, path };
  return { ...body, evidenceSha256: canonicalDigest({ ...body, detail }) };
}

function uniqueBy<T>(values: readonly T[], key: (value: T) => string): T[] {
  return [...new Map(values.map((value) => [key(value), value])).values()];
}
