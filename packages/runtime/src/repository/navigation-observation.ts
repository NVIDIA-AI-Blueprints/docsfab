// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { posix } from "node:path";

import { parseDocument, visit } from "yaml";

import { canonicalDigest, sha256 } from "../content-ir/canonical.js";
import type { ContentIndexV2 } from "../content-ir/contracts.js";
import {
  formatLimitOverflow,
  limit,
  type LimitOverflowObservationV1,
  type ResolveLimitsOptions,
} from "../config/limits.js";
import {
  REPOSITORY_NAVIGATION_MAX_SOURCES_LIMIT,
  REPOSITORY_NAVIGATION_MAX_SOURCE_BYTES_LIMIT,
  REPOSITORY_NAVIGATION_MAX_TOTAL_SOURCE_BYTES_LIMIT,
  REPOSITORY_NAVIGATION_MAX_TARGETS_LIMIT,
  REPOSITORY_NAVIGATION_MAX_TARGET_BYTES_LIMIT,
  REPOSITORY_NAVIGATION_MAX_TOTAL_TARGET_BYTES_LIMIT,
  type RepositoryNavigationBudgetsV1,
  repositoryNavigationBudgets,
} from "../config/repository-discovery-limits.js";
import { observeFernNavigation, type FernNavigationAdapter } from "./fern-navigation.js";
import { readTrackedRepositoryFile } from "./workspace/tracked-read.js";
import {
  RepositoryWorkspaceReadError,
  type RepositoryWorkspace,
  type TrackedRepositoryEntry,
} from "./workspace/contracts.js";
import { isRecord, compareText } from "../shared/primitives.js";

const SUPPORTED_NAVIGATION_NAMES = new Set([
  "mkdocs.yml",
  "mkdocs.yaml",
  "_toc.yml",
  "_toc.yaml",
  "sidebars.json",
]);
const UNSUPPORTED_NAVIGATION_NAMES = new Set([
  "sidebars.js",
  "sidebars.cjs",
  "sidebars.mjs",
  "sidebars.ts",
]);

export type RepositoryNavigationAdapter =
  | "docusaurus-json-v1"
  | "fern-yaml-v1"
  | "fern-versioned-yaml-v1"
  | "jupyter-book-toc-v1"
  | "mkdocs-yaml-v1";

export interface RepositoryNavigationObservationSourceV1 {
  adapter: RepositoryNavigationAdapter;
  path: string;
  contentSha256: string;
  evidenceSha256: string;
}

export interface RepositoryNavigationObservationRouteV1 {
  adapter: RepositoryNavigationAdapter;
  sourcePath: string;
  path: string;
  route: string | null;
  sourceSha256: string;
  targetSha256: string;
  evidenceSha256: string;
}

export interface RepositoryNavigationObservationFailureV1 {
  adapter: RepositoryNavigationAdapter;
  code: string;
  path: string;
  evidenceSha256: string;
  overflow?: LimitOverflowObservationV1;
}

interface AdapterObservation {
  adapter: RepositoryNavigationAdapter;
  status: "complete" | "incomplete";
  edgeCount: number;
  sources: RepositoryNavigationObservationSourceV1[];
  routes: RepositoryNavigationObservationRouteV1[];
  failures: RepositoryNavigationObservationFailureV1[];
}

export interface RepositoryNavigationObservationV1 {
  schemaVersion: 1;
  kind: "docsfab-repository-navigation-observation";
  repositoryRevision: string;
  status: "complete" | "incomplete";
  graphEdgeCount: number;
  navigationEdgeCount: number;
  paths: string[];
  sources: RepositoryNavigationObservationSourceV1[];
  routes: RepositoryNavigationObservationRouteV1[];
  failures: RepositoryNavigationObservationFailureV1[];
  contentIndexSha256: string | null;
  evidenceSha256: string;
}

/** Compose navigation adapters without requiring a global content graph first. */
export async function observeRepositoryNavigation(input: {
  workspace: RepositoryWorkspace;
  entries: readonly TrackedRepositoryEntry[];
  contentIndex?: ContentIndexV2;
  limits?: ResolveLimitsOptions;
}): Promise<RepositoryNavigationObservationV1> {
  const budgets = repositoryNavigationBudgets(input.limits);
  const entryByPath = new Map(
    input.entries.flatMap((entry) => (entry.path ? [[entry.path, entry] as const] : [])),
  );
  const recognized = input.entries.filter(
    (entry): entry is TrackedRepositoryEntry & { path: string } =>
      entry.path !== undefined &&
      (SUPPORTED_NAVIGATION_NAMES.has(posix.basename(entry.path)) ||
        UNSUPPORTED_NAVIGATION_NAMES.has(posix.basename(entry.path))),
  );
  const adapters: AdapterObservation[] = [];
  let sourceBytes = 0;
  let targetBytes = 0;
  if (recognized.length > budgets.maxSources) {
    adapters.push(
      failedAdapter(
        "mkdocs-yaml-v1",
        "source-budget-exceeded",
        recognized[0]?.path ?? "mkdocs.yml",
        input.workspace.revision,
        {
          limitName: REPOSITORY_NAVIGATION_MAX_SOURCES_LIMIT,
          observed: recognized.length,
        },
      ),
    );
  } else {
    for (const entry of recognized.sort((left, right) => compareText(left.path, right.path))) {
      const adapter = adapterFor(entry.path);
      if (UNSUPPORTED_NAVIGATION_NAMES.has(posix.basename(entry.path))) {
        adapters.push(
          failedAdapter(
            adapter,
            "unsupported-executable-navigation",
            entry.path,
            input.workspace.revision,
          ),
        );
        continue;
      }
      const result = await observeTrackedNavigationSource({
        workspace: input.workspace,
        entry,
        entryByPath,
        adapter,
        budgets,
        remainingSourceBytes: budgets.maxTotalSourceBytes - sourceBytes,
        remainingTargetBytes: budgets.maxTotalTargetBytes - targetBytes,
      });
      sourceBytes += result.sourceBytes;
      targetBytes += result.targetBytes;
      adapters.push(result.observation);
    }
  }

  const fern = await observeFernNavigation({ workspace: input.workspace, entries: input.entries });
  if (fern) {
    const adapter = fern.adapter;
    const sources = fern.sources.map((source) =>
      navigationSource(adapter, source.path, source.contentSha256),
    );
    const routes = fern.routes.map((route) =>
      navigationRoute({
        adapter,
        sourcePath: route.sourcePath,
        path: route.path,
        route: route.route,
        sourceSha256: route.sourceSha256,
        targetSha256: route.targetSha256,
      }),
    );
    adapters.push({
      adapter,
      status: fern.status,
      edgeCount: fern.status === "complete" ? routes.length : 0,
      sources,
      routes: fern.status === "complete" ? routes : [],
      failures: fern.failures.map((failure) =>
        navigationFailure(adapter, failure.code, failure.path, failure.evidenceSha256),
      ),
    });
  }

  const sources = uniqueBy(
    adapters.flatMap((adapter) => adapter.sources),
    (source) => `${source.adapter}\0${source.path}`,
  ).sort((left, right) =>
    compareText(`${left.adapter}\0${left.path}`, `${right.adapter}\0${right.path}`),
  );
  const routes = uniqueBy(
    adapters.flatMap((adapter) => adapter.routes),
    (route) => `${route.adapter}\0${route.sourcePath}\0${route.path}\0${route.route ?? ""}`,
  ).sort((left, right) =>
    compareText(
      `${left.adapter}\0${left.sourcePath}\0${left.path}\0${left.route ?? ""}`,
      `${right.adapter}\0${right.sourcePath}\0${right.path}\0${right.route ?? ""}`,
    ),
  );
  const failures = uniqueBy(
    adapters.flatMap((adapter) => adapter.failures),
    (failure) => failure.evidenceSha256,
  ).sort((left, right) =>
    compareText(
      `${left.adapter}\0${left.code}\0${left.path}`,
      `${right.adapter}\0${right.code}\0${right.path}`,
    ),
  );
  const independentEdgeCount = adapters.reduce((total, adapter) => total + adapter.edgeCount, 0);
  const contentNavigationEdgeCount =
    adapters.length === 0
      ? (input.contentIndex?.edges.filter((edge) => edge.kind === "navigation").length ?? 0)
      : 0;
  const status =
    adapters.length === 0
      ? input.contentIndex
        ? ("complete" as const)
        : ("incomplete" as const)
      : adapters.every((adapter) => adapter.status === "complete")
        ? ("complete" as const)
        : ("incomplete" as const);
  const paths = [
    ...new Set([
      ...sources.map((source) => source.path),
      ...routes.flatMap((route) => [route.sourcePath, route.path]),
    ]),
  ].sort(compareText);
  const contentGraphEdgeCount =
    input.contentIndex?.edges.filter((edge) => edge.kind !== "navigation").length ?? 0;
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-repository-navigation-observation" as const,
    repositoryRevision: input.workspace.revision,
    status,
    graphEdgeCount: contentGraphEdgeCount + independentEdgeCount + contentNavigationEdgeCount,
    navigationEdgeCount: independentEdgeCount + contentNavigationEdgeCount,
    paths,
    sources,
    routes,
    failures,
    contentIndexSha256: input.contentIndex?.indexDigest ?? null,
  };
  return { ...body, evidenceSha256: canonicalDigest(body) };
}

const SINGLE_AXIS_NAVIGATION_FAILURE_CATALOG: Readonly<Record<string, string | undefined>> =
  Object.freeze({
    "source-too-large": REPOSITORY_NAVIGATION_MAX_SOURCE_BYTES_LIMIT,
    "target-too-large": REPOSITORY_NAVIGATION_MAX_TARGET_BYTES_LIMIT,
  });

/** Recover-class operator lines for navigation budget failures; overflow is never dropped. */
export function formatRepositoryNavigationLimitations(
  observation: RepositoryNavigationObservationV1,
  options?: ResolveLimitsOptions,
): readonly string[] {
  return Object.freeze(
    observation.failures.map((failure) => {
      const catalog =
        failure.overflow?.limitName ?? SINGLE_AXIS_NAVIGATION_FAILURE_CATALOG[failure.code];
      if (!catalog) {
        if (
          failure.code === "source-budget-exceeded" ||
          failure.code === "target-budget-exceeded"
        ) {
          return `${failure.code}; exceeded a navigation budget (${failure.path})`;
        }
        return `${failure.adapter}:${failure.code}:${failure.path}`;
      }
      return `${failure.code}; ${formatLimitOverflow(
        limit(catalog, options),
        failure.overflow,
      )} (${failure.path})`;
    }),
  );
}

async function observeTrackedNavigationSource(input: {
  workspace: RepositoryWorkspace;
  entry: TrackedRepositoryEntry & { path: string };
  entryByPath: ReadonlyMap<string, TrackedRepositoryEntry>;
  adapter: Exclude<RepositoryNavigationAdapter, FernNavigationAdapter>;
  budgets: RepositoryNavigationBudgetsV1;
  remainingSourceBytes: number;
  remainingTargetBytes: number;
}): Promise<{ observation: AdapterObservation; sourceBytes: number; targetBytes: number }> {
  const { entry, adapter, budgets } = input;
  if (entry.kind !== "regular" || entry.byteLength === undefined) {
    return {
      observation: failedAdapter(adapter, "source-unsafe", entry.path, input.workspace.revision),
      sourceBytes: 0,
      targetBytes: 0,
    };
  }
  if (entry.byteLength > budgets.maxSourceBytes) {
    return {
      observation: failedAdapter(
        adapter,
        "source-too-large",
        entry.path,
        input.workspace.revision,
        { limitName: REPOSITORY_NAVIGATION_MAX_SOURCE_BYTES_LIMIT, observed: entry.byteLength },
      ),
      sourceBytes: 0,
      targetBytes: 0,
    };
  }
  if (entry.byteLength > input.remainingSourceBytes) {
    return {
      observation: failedAdapter(
        adapter,
        "source-budget-exceeded",
        entry.path,
        input.workspace.revision,
        {
          limitName: REPOSITORY_NAVIGATION_MAX_TOTAL_SOURCE_BYTES_LIMIT,
          observed: budgets.maxTotalSourceBytes - input.remainingSourceBytes + entry.byteLength,
        },
      ),
      sourceBytes: 0,
      targetBytes: 0,
    };
  }

  let bytes: Buffer;
  try {
    bytes = await readTrackedRepositoryFile(input.workspace, entry.path, budgets.maxSourceBytes);
  } catch (error) {
    return {
      observation: failedAdapter(
        adapter,
        readCode(error, "source"),
        entry.path,
        input.workspace.revision,
      ),
      sourceBytes: 0,
      targetBytes: 0,
    };
  }
  let groups: string[][];
  try {
    const source = strictUtf8(bytes);
    groups =
      adapter === "docusaurus-json-v1"
        ? docusaurusGroups(source)
        : adapter === "mkdocs-yaml-v1"
          ? mkdocsGroups(source)
          : jupyterBookGroups(source);
    if (groups.flat().length === 0)
      throw new Error("Navigation source has no supported tracked documentation targets.");
    if (groups.flat().length > budgets.maxTargets) {
      throw new NavigationBudgetError({
        limitName: REPOSITORY_NAVIGATION_MAX_TARGETS_LIMIT,
        observed: groups.flat().length,
      });
    }
  } catch (error) {
    return {
      observation: failedAdapter(
        adapter,
        error instanceof NavigationExtractionError
          ? error.code
          : error instanceof NavigationBudgetError
            ? "target-budget-exceeded"
            : "malformed-navigation",
        entry.path,
        error instanceof Error ? error.message : input.workspace.revision,
        error instanceof NavigationBudgetError ? error.overflow : undefined,
      ),
      sourceBytes: bytes.byteLength,
      targetBytes: 0,
    };
  }

  const sourceSha256 = sha256(bytes);
  const source = navigationSource(adapter, entry.path, sourceSha256);
  const routes: RepositoryNavigationObservationRouteV1[] = [];
  const failures: RepositoryNavigationObservationFailureV1[] = [];
  let targetBytes = 0;
  let edgeCount = 0;
  for (const group of groups) {
    const resolvedGroup: string[] = [];
    for (const rawTarget of group) {
      const resolvedTarget = resolveNavigationTarget(entry.path, rawTarget, input.entryByPath);
      if (!resolvedTarget.path) {
        failures.push(navigationFailure(adapter, resolvedTarget.code, entry.path, rawTarget));
        continue;
      }
      const targetPath = resolvedTarget.path;
      const target = input.entryByPath.get(targetPath)!;
      if (target.kind !== "regular" || target.byteLength === undefined) {
        failures.push(
          navigationFailure(adapter, "target-unsafe", targetPath, input.workspace.revision),
        );
        continue;
      }
      if (target.byteLength > budgets.maxTargetBytes) {
        failures.push(
          navigationFailure(adapter, "target-too-large", targetPath, input.workspace.revision, {
            limitName: REPOSITORY_NAVIGATION_MAX_TARGET_BYTES_LIMIT,
            observed: target.byteLength,
          }),
        );
        continue;
      }
      if (targetBytes + target.byteLength > input.remainingTargetBytes) {
        failures.push(
          navigationFailure(
            adapter,
            "target-budget-exceeded",
            targetPath,
            input.workspace.revision,
            {
              limitName: REPOSITORY_NAVIGATION_MAX_TOTAL_TARGET_BYTES_LIMIT,
              observed:
                budgets.maxTotalTargetBytes -
                input.remainingTargetBytes +
                targetBytes +
                target.byteLength,
            },
          ),
        );
        continue;
      }
      try {
        const targetContent = await readTrackedRepositoryFile(
          input.workspace,
          targetPath,
          budgets.maxTargetBytes,
        );
        targetBytes += targetContent.byteLength;
        resolvedGroup.push(targetPath);
        routes.push(
          navigationRoute({
            adapter,
            sourcePath: entry.path,
            path: targetPath,
            route: null,
            sourceSha256,
            targetSha256: sha256(targetContent),
          }),
        );
      } catch (error) {
        failures.push(
          navigationFailure(
            adapter,
            readCode(error, "target"),
            targetPath,
            input.workspace.revision,
          ),
        );
      }
    }
    edgeCount += Math.max(0, resolvedGroup.length - 1);
  }
  return {
    observation: {
      adapter,
      status: failures.length === 0 ? "complete" : "incomplete",
      edgeCount: failures.length === 0 ? edgeCount : 0,
      sources: [source],
      routes: failures.length === 0 ? routes : [],
      failures,
    },
    sourceBytes: bytes.byteLength,
    targetBytes,
  };
}

class NavigationBudgetError extends Error {
  constructor(readonly overflow: LimitOverflowObservationV1) {
    super("Navigation source exceeds the bounded documentation target budget.");
  }
}

class NavigationExtractionError extends Error {
  constructor(
    message: string,
    readonly code:
      | "navigation-missing"
      | "unsupported-navigation-shape"
      | "unsupported-navigation-target",
  ) {
    super(message);
  }
}

function yamlValue(source: string): unknown {
  const document = parseDocument(source, { strict: true, uniqueKeys: true });
  if (document.errors.length > 0 || document.warnings.length > 0)
    throw new Error("Navigation YAML is malformed or contains unsupported syntax.");
  let alias = false;
  visit(document, {
    Alias: () => {
      alias = true;
      return visit.BREAK;
    },
  });
  if (alias) throw new Error("Navigation YAML aliases are unsupported by the bounded observer.");
  return document.toJS({ maxAliasCount: 0 }) as unknown;
}

function mkdocsGroups(source: string): string[][] {
  const value = yamlValue(source);
  if (!isRecord(value) || !Object.hasOwn(value, "nav")) {
    throw new NavigationExtractionError(
      "MkDocs navigation requires an explicit top-level nav field.",
      "navigation-missing",
    );
  }
  if (!Array.isArray(value.nav)) {
    throw new NavigationExtractionError(
      "The MkDocs nav value must be a static sequence.",
      "unsupported-navigation-shape",
    );
  }
  return [mkdocsTargets(value.nav)];
}

function mkdocsTargets(value: unknown): string[] {
  if (typeof value === "string") return [supportedDocumentTarget(value)];
  if (Array.isArray(value)) return value.flatMap(mkdocsTargets);
  if (!isRecord(value)) {
    throw new NavigationExtractionError(
      "MkDocs nav entries must be document paths, sequences, or single-title mappings.",
      "unsupported-navigation-shape",
    );
  }
  const keys = Object.keys(value);
  if (keys.length !== 1) {
    throw new NavigationExtractionError(
      "MkDocs title mappings must contain exactly one navigation member.",
      "unsupported-navigation-shape",
    );
  }
  return mkdocsTargets(value[keys[0]!]);
}

function jupyterBookGroups(source: string): string[][] {
  const value = yamlValue(source);
  if (!isRecord(value) || typeof value.root !== "string") {
    throw new NavigationExtractionError(
      "Jupyter Book navigation requires a static root document.",
      "navigation-missing",
    );
  }
  if (Object.hasOwn(value, "parts")) {
    throw new NavigationExtractionError(
      "Jupyter Book parts are outside the bounded root/chapters/sections grammar.",
      "unsupported-navigation-shape",
    );
  }
  const targets = [supportedDocumentTarget(value.root)];
  for (const key of ["chapters", "sections"] as const) {
    if (!Object.hasOwn(value, key)) continue;
    if (!Array.isArray(value[key])) {
      throw new NavigationExtractionError(
        `Jupyter Book ${key} must be a static sequence.`,
        "unsupported-navigation-shape",
      );
    }
    targets.push(...jupyterBookTargets(value[key]));
  }
  return [targets];
}

function jupyterBookTargets(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new NavigationExtractionError(
      "Jupyter Book child collections must be static sequences.",
      "unsupported-navigation-shape",
    );
  }
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.file !== "string") {
      throw new NavigationExtractionError(
        "Jupyter Book child entries require a static file field.",
        "unsupported-navigation-shape",
      );
    }
    const unsupportedKeys = Object.keys(item).filter((key) => key !== "file" && key !== "sections");
    if (unsupportedKeys.length > 0) {
      throw new NavigationExtractionError(
        "Jupyter Book child entries contain unsupported navigation semantics.",
        "unsupported-navigation-shape",
      );
    }
    const targets = [supportedDocumentTarget(item.file)];
    if (Object.hasOwn(item, "sections")) targets.push(...jupyterBookTargets(item.sections));
    return targets;
  });
}

function docusaurusGroups(source: string): string[][] {
  const value: unknown = JSON.parse(source);
  if (Array.isArray(value)) return [docusaurusTargets(value)];
  if (!isRecord(value)) {
    throw new NavigationExtractionError(
      "Docusaurus sidebars must be a static sequence or named static sequences.",
      "unsupported-navigation-shape",
    );
  }
  return Object.keys(value)
    .sort(compareText)
    .map((key) => {
      if (!Array.isArray(value[key])) {
        throw new NavigationExtractionError(
          "Each named Docusaurus sidebar must be a static sequence.",
          "unsupported-navigation-shape",
        );
      }
      return docusaurusTargets(value[key]);
    });
}

function docusaurusTargets(value: unknown): string[] {
  if (typeof value === "string") return [supportedDocumentTarget(value)];
  if (Array.isArray(value)) return value.flatMap(docusaurusTargets);
  if (!isRecord(value)) {
    throw new NavigationExtractionError(
      "Docusaurus sidebar entries must use the bounded static grammar.",
      "unsupported-navigation-shape",
    );
  }
  const type = typeof value.type === "string" ? value.type : undefined;
  if (type === "doc" || type === "ref") {
    if (typeof value.id !== "string") {
      throw new NavigationExtractionError(
        `Docusaurus ${type} sidebar entries require a static tracked document id.`,
        "unsupported-navigation-shape",
      );
    }
    return [supportedDocumentTarget(value.id)];
  }
  if (type === "category") {
    if (!Array.isArray(value.items)) {
      throw new NavigationExtractionError(
        "Docusaurus categories require a static sequence of sidebar items.",
        "unsupported-navigation-shape",
      );
    }
    const linkTargets = Object.hasOwn(value, "link") ? docusaurusTargets(value.link) : [];
    return [...linkTargets, ...docusaurusTargets(value.items)];
  }
  throw new NavigationExtractionError(
    `Docusaurus sidebar type ${type ?? "<missing>"} is outside the bounded static grammar.`,
    "unsupported-navigation-shape",
  );
}

function supportedDocumentTarget(value: string): string {
  const target = value.trim();
  const extension = posix.extname(target).toLowerCase();
  if (
    !target ||
    target.includes("#") ||
    target.includes("?") ||
    target.startsWith("//") ||
    /^[a-z][a-z0-9+.-]*:/iu.test(target) ||
    (extension !== "" && extension !== ".md" && extension !== ".mdx")
  ) {
    throw new NavigationExtractionError(
      `Navigation target ${target || "<empty>"} is outside the bounded document grammar.`,
      "unsupported-navigation-target",
    );
  }
  return target;
}

function resolveNavigationTarget(
  sourcePath: string,
  rawTarget: string,
  entries: ReadonlyMap<string, TrackedRepositoryEntry>,
): { path?: string; code: "target-missing" | "unsafe-navigation-path" } {
  const base = posix.dirname(sourcePath);
  const normalized = posix.normalize(posix.join(base === "." ? "" : base, rawTarget));
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/")
  )
    return { code: "unsafe-navigation-path" };
  const path = documentCandidates(normalized).find((candidate) => entries.has(candidate));
  return path ? { path, code: "target-missing" } : { code: "target-missing" };
}

function documentCandidates(path: string): string[] {
  if (/\.mdx?$/iu.test(path)) return [path];
  const trimmed = path.replace(/\/$/u, "");
  return [
    `${trimmed}.md`,
    `${trimmed}.mdx`,
    `${trimmed}/README.md`,
    `${trimmed}/index.md`,
    `${trimmed}/index.mdx`,
  ];
}

function adapterFor(path: string): Exclude<RepositoryNavigationAdapter, FernNavigationAdapter> {
  const name = posix.basename(path);
  if (name === "sidebars.json" || UNSUPPORTED_NAVIGATION_NAMES.has(name))
    return "docusaurus-json-v1";
  if (name === "_toc.yml" || name === "_toc.yaml") return "jupyter-book-toc-v1";
  return "mkdocs-yaml-v1";
}

function navigationSource(
  adapter: RepositoryNavigationAdapter,
  path: string,
  contentSha256: string,
): RepositoryNavigationObservationSourceV1 {
  const body = { adapter, path, contentSha256 };
  return { ...body, evidenceSha256: canonicalDigest(body) };
}

function navigationRoute(
  body: Omit<RepositoryNavigationObservationRouteV1, "evidenceSha256">,
): RepositoryNavigationObservationRouteV1 {
  return { ...body, evidenceSha256: canonicalDigest(body) };
}

function navigationFailure(
  adapter: RepositoryNavigationAdapter,
  code: string,
  path: string,
  detail: string,
  overflow?: LimitOverflowObservationV1,
): RepositoryNavigationObservationFailureV1 {
  const body = { adapter, code, path };
  const digestBody = overflow ? { ...body, detail, overflow } : { ...body, detail };
  return {
    ...body,
    ...(overflow ? { overflow } : {}),
    evidenceSha256: canonicalDigest(digestBody),
  };
}

function failedAdapter(
  adapter: RepositoryNavigationAdapter,
  code: string,
  path: string,
  detail: string,
  overflow?: LimitOverflowObservationV1,
): AdapterObservation {
  return {
    adapter,
    status: "incomplete",
    edgeCount: 0,
    sources: [],
    routes: [],
    failures: [navigationFailure(adapter, code, path, detail, overflow)],
  };
}

function readCode(error: unknown, prefix: "source" | "target"): string {
  if (!(error instanceof RepositoryWorkspaceReadError)) return `${prefix}-unreadable`;
  if (error.code === "not-tracked") return `${prefix}-missing`;
  if (error.code === "unsafe-kind") return `${prefix}-unsafe`;
  if (error.code === "oversize") return `${prefix}-too-large`;
  if (error.code === "changed") return `${prefix}-changed`;
  return `${prefix}-unreadable`;
}

function strictUtf8(bytes: Buffer): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function uniqueBy<T>(values: readonly T[], key: (value: T) => string): T[] {
  return [...new Map(values.map((value) => [key(value), value])).values()];
}
