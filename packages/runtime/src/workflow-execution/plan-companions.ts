// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Navigation companions and post-write reachability for documentation plans.
 *
 * A plan that creates or moves content into pages admits the docs-root index
 * beside those pages, so the writer may link them, and after the write every
 * such page is checked for a path from declared navigation or the index. The
 * check labels what it finds; it never stops a run. Only an index edit that
 * drops an existing link is refused.
 */
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { posix, resolve, sep } from "node:path";

import { sha256 } from "../content-ir/canonical.js";
import {
  formatLimitObservation,
  LIMIT_DEFINITION_BY_NAME,
  limit,
  type ResolvedLimit,
  type ResolveLimitsOptions,
} from "../config/limits.js";
import {
  REPOSITORY_INVENTORY_MAX_ENTRIES_LIMIT,
  REPOSITORY_NAVIGATION_MAX_SOURCE_BYTES_LIMIT,
} from "../config/repository-discovery-limits.js";
import { withinWriteCeiling } from "../host-invoker/wire-decode.js";
import {
  parseMkdocsConfiguration,
  mkdocsNavigationLeaves,
} from "../repository/documentation-source-mkdocs.js";
import {
  DOCUMENTATION_SOURCE_CONFIGURATION_LOCATIONS,
  documentationMarkdownLinkTargets,
  documentationSourceAdapterForConfiguration,
  documentationSourceValidationAdapter,
  resolveDocumentationSourceAdapter,
  type DocumentationSourceAdapterId,
} from "../repository/documentation-source-support.js";
import { compareText } from "../shared/primitives.js";
import {
  documentationPlanPagePaths,
  isDocumentationPlanPath,
  type AdmittedDocumentationPlanBinding,
  type DocumentationPageDisposition,
  type DocumentationPlanNavigationCompanionV1,
} from "./plan-binding.js";

/**
 * The default documentation write roots, and the only paths a local companion
 * may take, narrowed to the run's own write roots. A hosted run passes its
 * installed ceiling.
 */
export const LOCAL_DOCUMENTATION_WRITE_ROOTS: readonly string[] = Object.freeze(["docs/", "fern/"]);

/**
 * The entries two write ceilings both cover, in the same form: a directory
 * entry ends in `/` and covers its subtree, any other entry covers exactly
 * itself. An entry of one ceiling is kept when the other covers it whole: a
 * directory inside one of its directories, or a file inside it.
 */
export function intersectWriteCeilings(
  left: readonly string[],
  right: readonly string[],
): readonly string[] {
  const covered = (entry: string, ceiling: readonly string[]) =>
    entry.endsWith("/")
      ? ceiling.some((other) => other.endsWith("/") && entry.startsWith(other))
      : withinWriteCeiling(entry, ceiling);
  return Object.freeze(
    [
      ...new Set([
        ...left.filter((entry) => covered(entry, right)),
        ...right.filter((entry) => covered(entry, left)),
      ]),
    ].sort(compareText),
  );
}

/**
 * The navigation files a restructure plan may write although they are not
 * Markdown pages: the declarative navigation of the sealed adapters that keep
 * it in YAML, Fern's `fern/docs.yml` and MkDocs' `mkdocs.yml`. Docusaurus
 * and Sphinx declare navigation in code (`sidebars.js`, `conf.py`), which no
 * plan writes. Any other file that is not a page stays refused.
 */
export const RESTRUCTURE_NAVIGATION_FILES: ReadonlySet<string> = new Set(
  (["fern", "mkdocs"] as const).flatMap(
    (id) => resolveDocumentationSourceAdapter(id).configurationLocations,
  ),
);

/**
 * Whether a restructure plan may write `path` as navigation: exactly the
 * supported path observed as a regular file in the base workspace, inside
 * the write roots. Reachability precedence does not determine write authority.
 */
export function isRestructureNavigationWrite(
  path: string,
  roots: readonly string[],
  navigationFiles: readonly string[],
): boolean {
  return (
    navigationFiles.some(
      (navigation) => path === navigation && RESTRUCTURE_NAVIGATION_FILES.has(navigation),
    ) && withinWriteCeiling(path, roots)
  );
}

/** Index file names a documentation root may hold, in the order one is chosen. */
export const DOCUMENTATION_INDEX_NAMES = Object.freeze(["index.md", "README.md", "index.mdx"]);

/**
 * Dispositions whose page receives new or moved content. An `update` page was
 * reachable or not before the run, so it is never labeled for that.
 */
const TRIGGER_DISPOSITIONS: ReadonlySet<DocumentationPageDisposition> = new Set([
  "create",
  "move",
  "merge",
  "split",
  "restructure",
]);

const MARKDOWN_PAGE = /\.(?:md|mdx)$/iu;
const LINK_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/u;
const PLANNED_PAGE_MAX_BYTES_LIMIT = "authoring.plannedPageMaxBytes";
const MKDOCS_CONFIGURATION_NAMES = new Set(
  resolveDocumentationSourceAdapter("mkdocs").configurationLocations,
);

export const NAVIGATION_LABEL_CODES = [
  "navigation-companion-not-granted",
  "navigation-unreachable-page",
  "navigation-not-checked",
] as const;
export type NavigationLabelCode = (typeof NAVIGATION_LABEL_CODES)[number];

/** Why the reachability check could not decide for the run's pages. */
export const NAVIGATION_NOT_CHECKED_REASONS = [
  "no-navigation-or-index",
  "navigation-unread",
  "limit-exceeded",
] as const;
export type NavigationNotCheckedReason = (typeof NAVIGATION_NOT_CHECKED_REASONS)[number];

/**
 * One label on a run's navigation, content-free: closed codes and paths that
 * passed the plan path grammar. Labels never stop a run.
 */
export type NavigationLabelV1 =
  | {
      readonly code: "navigation-companion-not-granted";
      /** The navigation or index file the pages need, which the grant excludes. */
      readonly path: string;
      readonly grant: readonly string[];
    }
  | {
      readonly code: "navigation-unreachable-page";
      readonly path: string;
      /** The navigation file and index the closure started from, or null when absent. */
      readonly navigation: string | null;
      readonly index: string | null;
    }
  | {
      readonly code: "navigation-not-checked";
      readonly path: null;
      readonly reason: NavigationNotCheckedReason;
      /** The navigation file this check could not read, when that is the reason. */
      readonly navigation: string | null;
      /** The catalogued bound the check reached, when that is the reason. */
      readonly limit: NavigationLimitOverrunV1 | null;
    };

/** A catalogued bound, its effective value for the run, and what crossed it. */
export interface NavigationLimitOverrunV1 {
  readonly name: string;
  readonly observed: number;
  readonly value: number;
}

function overrun(bound: ResolvedLimit, observed: number): NavigationLimitOverrunV1 {
  return { name: bound.name, observed, value: bound.value };
}

/** What the host read beside the plan's pages, before any write. */
export interface DocumentationRootObservationV1 {
  /** The chosen index of each documentation root that holds one. */
  readonly indexes: readonly { readonly path: string; readonly sha256: string }[];
  /** The repository's declared navigation, when one is recognized. */
  readonly navigation: DocumentationNavigationObservationV1 | null;
  /** A navigation read that reached a bound; the check then labels instead of passing. */
  readonly overflow: NavigationLimitOverrunV1 | null;
}

export type DocumentationNavigationObservationV1 =
  | { readonly path: string; readonly mode: "automatic" }
  | { readonly path: string; readonly mode: "explicit"; readonly entries: readonly string[] }
  | { readonly path: string; readonly mode: "unread" };

export interface DocumentationPlanCompanionsV1 {
  readonly companions: readonly DocumentationPlanNavigationCompanionV1[];
  readonly labels: readonly NavigationLabelV1[];
}

/** Pages whose disposition receives new or moved content. */
export function companionTriggerPages(plan: AdmittedDocumentationPlanBinding): readonly string[] {
  return plan.pages
    .filter((page) => TRIGGER_DISPOSITIONS.has(page.disposition))
    .map((page) => page.path)
    .sort(compareText);
}

/** The documentation root of a page: its first directory, or "" at the repository root. */
function documentationRoot(path: string): string {
  const slash = path.indexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/**
 * The navigation companions a plan admits, and the labels for what it wants
 * but may not have. Only a RESTRUCTURE plan with a page in the trigger set
 * gets companions; a CREATE plan is checked for reachability after its write
 * but never widened. A companion is a root's existing Markdown index inside
 * `effectiveGrant`. An index outside the grant, or a declared explicit
 * navigation file (never a companion here), is one label each.
 */
export function documentationPlanCompanions(
  plan: AdmittedDocumentationPlanBinding,
  docsRoot: DocumentationRootObservationV1,
  effectiveGrant: readonly string[],
): DocumentationPlanCompanionsV1 {
  const triggers = companionTriggerPages(plan);
  if (plan.mode !== "restructure" || triggers.length === 0) {
    return { companions: [], labels: [] };
  }
  const listed = new Set(plan.pages.map((page) => page.path));
  const roots = new Set(triggers.map(documentationRoot));
  const companions: DocumentationPlanNavigationCompanionV1[] = [];
  const labels: NavigationLabelV1[] = [];
  for (const index of docsRoot.indexes) {
    if (!roots.has(documentationRoot(index.path))) continue;
    // The planner already listed it; its own row decides, and preservation
    // still applies to it after the write.
    if (listed.has(index.path)) continue;
    if (!withinWriteCeiling(index.path, effectiveGrant)) {
      labels.push(notGranted(index.path, effectiveGrant));
      continue;
    }
    companions.push({ path: index.path, role: "companion-index", baseSha256: index.sha256 });
  }
  if (docsRoot.navigation?.mode === "explicit" && !listed.has(docsRoot.navigation.path)) {
    labels.push(notGranted(docsRoot.navigation.path, effectiveGrant));
  }
  return {
    companions: companions.sort((left, right) => compareText(left.path, right.path)),
    labels,
  };
}

function notGranted(path: string, grant: readonly string[]): NavigationLabelV1 {
  return {
    code: "navigation-companion-not-granted",
    path,
    grant: [...grant].sort(compareText),
  };
}

/**
 * The index paths whose existing links an edit must keep: every companion,
 * and an index the planner listed itself as a page it changes.
 */
export function preservedIndexPaths(
  plan: AdmittedDocumentationPlanBinding,
  docsRoot: Pick<DocumentationRootObservationV1, "indexes">,
): readonly string[] {
  const companions = (plan.navigationCompanions ?? []).map((companion) => companion.path);
  const changedPages = new Set(documentationPlanPagePaths(plan));
  const listedIndexes = docsRoot.indexes
    .map((index) => index.path)
    .filter((path) => changedPages.has(path));
  return [...new Set([...companions, ...listedIndexes])].sort(compareText);
}

// ---------------------------------------------------------------------------
// Reading the workspace

/** A confined workspace reader: regular files only, never through a link. */
interface WorkspaceReader {
  read(path: string, maxBytes: number): Promise<WorkspaceRead>;
}

type WorkspaceRead =
  | { readonly kind: "absent" }
  | { readonly kind: "too-large"; readonly byteLength: number }
  | { readonly kind: "file"; readonly bytes: Buffer };

function workspaceReader(workspacePath: string): WorkspaceReader {
  let root: Promise<string | null> | undefined;
  const rootReal = (): Promise<string | null> =>
    (root ??= realpath(workspacePath).catch(() => null));
  return {
    async read(path, maxBytes) {
      if (!isDocumentationPlanPath(path)) return { kind: "absent" };
      const base = await rootReal();
      if (base === null) return { kind: "absent" };
      const absolute = resolve(base, path);
      let parent: string;
      try {
        parent = await realpath(resolve(absolute, ".."));
      } catch {
        return { kind: "absent" };
      }
      // A directory link out of the workspace reads as absent, never as its target.
      if (parent !== base && !parent.startsWith(base + sep)) return { kind: "absent" };
      let handle;
      try {
        handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
      } catch {
        return { kind: "absent" };
      }
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) return { kind: "absent" };
        if (stat.size > maxBytes) return { kind: "too-large", byteLength: stat.size };
        const bytes = await handle.readFile();
        if (bytes.length > maxBytes) return { kind: "too-large", byteLength: bytes.length };
        return { kind: "file", bytes };
      } finally {
        await handle.close();
      }
    },
  };
}

interface ReachabilityBudgets {
  readonly maxNodes: ResolvedLimit;
  readonly maxPageBytes: ResolvedLimit;
  readonly maxNavigationBytes: ResolvedLimit;
}

function reachabilityBudgets(options?: ResolveLimitsOptions): ReachabilityBudgets {
  return {
    maxNodes: limit(REPOSITORY_INVENTORY_MAX_ENTRIES_LIMIT, options),
    maxPageBytes: limit(PLANNED_PAGE_MAX_BYTES_LIMIT, options),
    maxNavigationBytes: limit(REPOSITORY_NAVIGATION_MAX_SOURCE_BYTES_LIMIT, options),
  };
}

/**
 * Read, before any write, the index of each root a trigger page sits in and
 * the repository's declared navigation. Only the sealed adapters' own
 * configuration files count as navigation; MkDocs is read for its `nav`, and
 * any other recognized navigation is recorded as present but unread.
 */
export async function observeDocumentationRoots(input: {
  readonly workspacePath: string;
  readonly plan: AdmittedDocumentationPlanBinding;
  readonly limits?: ResolveLimitsOptions;
}): Promise<DocumentationRootObservationV1> {
  const reader = workspaceReader(input.workspacePath);
  const budgets = reachabilityBudgets(input.limits);
  const roots = [...new Set(companionTriggerPages(input.plan).map(documentationRoot))].sort(
    compareText,
  );
  const indexes: { path: string; sha256: string }[] = [];
  let overflow: DocumentationRootObservationV1["overflow"] = null;
  for (const root of roots) {
    for (const name of DOCUMENTATION_INDEX_NAMES) {
      const path = root ? `${root}/${name}` : name;
      const read = await reader.read(path, budgets.maxPageBytes.value);
      if (read.kind === "absent") continue;
      if (read.kind === "too-large") {
        overflow ??= overrun(budgets.maxPageBytes, read.byteLength);
        break;
      }
      indexes.push({ path, sha256: sha256(read.bytes) });
      break;
    }
  }
  const navigation = await observeNavigation(reader, budgets);
  return {
    indexes,
    navigation: navigation.observation,
    overflow: overflow ?? navigation.overflow,
  };
}

/** Adapters that own a root when several configuration files are present. */
function rootOwningAdapters(
  adapters: readonly DocumentationSourceAdapterId[],
): ReadonlySet<DocumentationSourceAdapterId> {
  const native = adapters.filter(
    (adapterId) => documentationSourceValidationAdapter(adapterId) === adapterId,
  );
  return new Set(native.length > 0 ? native : adapters);
}

function selectNavigationConfigurationPath(presentPaths: readonly string[]): string | undefined {
  if (presentPaths.length === 0) return undefined;
  const adapters = presentPaths.map((path) => documentationSourceAdapterForConfiguration(path)!);
  const owners = rootOwningAdapters(adapters);
  const owned = presentPaths.filter((path) =>
    owners.has(documentationSourceAdapterForConfiguration(path)!),
  );
  const mkdocs = owned.find((path) => MKDOCS_CONFIGURATION_NAMES.has(path));
  if (mkdocs) return mkdocs;
  return [...owned].sort(compareText)[0];
}

/** The repository's declared navigation, read as `observeDocumentationRoots` reads it. */
export async function observeDocumentationNavigation(input: {
  readonly workspacePath: string;
  readonly limits?: ResolveLimitsOptions;
}): Promise<DocumentationNavigationObservationV1 | null> {
  return (
    await observeNavigation(workspaceReader(input.workspacePath), reachabilityBudgets(input.limits))
  ).observation;
}

/** Supported navigation paths present as regular files in the confined base workspace. */
export async function observeRestructureNavigationFiles(input: {
  readonly workspacePath: string;
  readonly limits?: ResolveLimitsOptions;
}): Promise<readonly string[]> {
  const reader = workspaceReader(input.workspacePath);
  const budgets = reachabilityBudgets(input.limits);
  const present: string[] = [];
  for (const path of [...RESTRUCTURE_NAVIGATION_FILES].sort(compareText)) {
    const read = await reader.read(path, budgets.maxNavigationBytes.value);
    // The reader confirms a regular file before reporting a size overrun.
    if (read.kind !== "absent") present.push(path);
  }
  return present;
}

async function observeNavigation(
  reader: WorkspaceReader,
  budgets: ReachabilityBudgets,
): Promise<{
  observation: DocumentationNavigationObservationV1 | null;
  overflow: DocumentationRootObservationV1["overflow"];
}> {
  const locations = [...new Set(DOCUMENTATION_SOURCE_CONFIGURATION_LOCATIONS)].sort(compareText);
  const present: { path: string; bytes: Buffer }[] = [];
  for (const path of locations) {
    const read = await reader.read(path, budgets.maxNavigationBytes.value);
    if (read.kind === "absent") continue;
    if (read.kind === "too-large") {
      return {
        observation: { path, mode: "unread" },
        overflow: overrun(budgets.maxNavigationBytes, read.byteLength),
      };
    }
    present.push({ path, bytes: read.bytes });
  }
  const selectedPath = selectNavigationConfigurationPath(present.map((entry) => entry.path));
  if (selectedPath === undefined) return { observation: null, overflow: null };
  const selected = present.find((entry) => entry.path === selectedPath)!;
  if (!MKDOCS_CONFIGURATION_NAMES.has(selected.path)) {
    return { observation: { path: selected.path, mode: "unread" }, overflow: null };
  }
  try {
    const configuration = parseMkdocsConfiguration(selected.bytes.toString("utf8"));
    if (configuration.navigationMode === "automatic" || configuration.nav === null) {
      return { observation: { path: selected.path, mode: "automatic" }, overflow: null };
    }
    // Nav targets are relative to `docs_dir`, as a link from its index is.
    const from = `${configuration.docsDir}/index.md`;
    const entries = mkdocsNavigationLeaves(configuration.nav).flatMap((leaf) => {
      const target = resolveLinkTarget(from, leaf.target);
      return target ? [target] : [];
    });
    return { observation: { path: selected.path, mode: "explicit", entries }, overflow: null };
  } catch {
    // A configuration this parser refuses is navigation the check cannot read.
    return { observation: { path: selected.path, mode: "unread" }, overflow: null };
  }
}

/**
 * The repository path a local Markdown link from `fromPath` names, without
 * fragment or query, or undefined for an external or escaping link.
 */
function resolveLinkTarget(fromPath: string, target: string): string | undefined {
  const trimmed = target.trim().replace(/^<|>$/gu, "");
  if (!trimmed || trimmed.startsWith("#") || LINK_SCHEME.test(trimmed)) return undefined;
  const withoutSuffix = trimmed.split("#")[0]!.split("?")[0]!;
  if (!withoutSuffix) return undefined;
  let decoded: string;
  try {
    decoded = decodeURI(withoutSuffix);
  } catch {
    return undefined;
  }
  const joined = decoded.startsWith("/")
    ? posix.normalize(decoded.slice(1))
    : posix.normalize(posix.join(posix.dirname(fromPath), decoded));
  if (joined === "." || joined.startsWith("../") || joined === "..") return undefined;
  return decoded.endsWith("/") && !joined.endsWith("/") ? `${joined}/` : joined;
}

/** The Markdown files a resolved link may name, in the order they are tried. */
function linkCandidates(target: string): readonly string[] {
  if (target.endsWith("/")) return DOCUMENTATION_INDEX_NAMES.map((name) => `${target}${name}`);
  if (MARKDOWN_PAGE.test(target)) return [target];
  return [
    `${target}.md`,
    `${target}.mdx`,
    ...DOCUMENTATION_INDEX_NAMES.map((name) => `${target}/${name}`),
  ];
}

/** The resolved local link targets of one Markdown file. */
export function indexLinkTargets(indexPath: string, source: string): readonly string[] {
  return [
    ...new Set(
      documentationMarkdownLinkTargets(source).flatMap((target) => {
        const resolved = resolveLinkTarget(indexPath, target);
        return resolved ? [resolved] : [];
      }),
    ),
  ].sort(compareText);
}

/**
 * An index edit removed or retargeted an existing link. The candidate is not
 * admitted: every page the index linked before the run must stay linked.
 */
export class NavigationCompanionLinkRemovedError extends Error {
  public readonly code = "navigation-companion-link-removed" as const;

  public constructor(
    public readonly path: string,
    public readonly removed: readonly string[],
  ) {
    // `path` passed the plan path grammar; a removed target is repository link
    // text, so only targets that pass the same grammar are named.
    const named = removed.filter(isDocumentationPlanPath);
    const unnamed = removed.length - named.length;
    super(
      `navigation-companion-link-removed: the edit of ${path} drops ${String(removed.length)} ` +
        `existing link target(s) (${[...named, ...(unnamed > 0 ? [`${String(unnamed)} not shown`] : [])].join(", ")}). ` +
        "Remediation: keep every existing entry of the index and add entries for new pages; " +
        "rerun the documentation workflow.",
    );
    this.name = "NavigationCompanionLinkRemovedError";
  }
}

/** The base link targets of each preserved index, read before any write. */
export async function readIndexLinkBases(input: {
  readonly workspacePath: string;
  readonly paths: readonly string[];
  readonly limits?: ResolveLimitsOptions;
}): Promise<ReadonlyMap<string, readonly string[]>> {
  const reader = workspaceReader(input.workspacePath);
  const maxBytes = limit(PLANNED_PAGE_MAX_BYTES_LIMIT, input.limits).value;
  const bases = new Map<string, readonly string[]>();
  for (const path of input.paths) {
    const read = await reader.read(path, maxBytes);
    // The observation that chose the index read it within the same bound.
    if (read.kind !== "file") continue;
    bases.set(path, indexLinkTargets(path, read.bytes.toString("utf8")));
  }
  return bases;
}

/**
 * Refuse an index edit that dropped an existing link target. An index that no
 * longer exists dropped all of them.
 */
export async function assertIndexLinksPreserved(input: {
  readonly workspacePath: string;
  readonly bases: ReadonlyMap<string, readonly string[]>;
  readonly limits?: ResolveLimitsOptions;
}): Promise<void> {
  const reader = workspaceReader(input.workspacePath);
  const maxBytes = limit(PLANNED_PAGE_MAX_BYTES_LIMIT, input.limits).value;
  for (const [path, base] of [...input.bases].sort(([left], [right]) => compareText(left, right))) {
    const read = await reader.read(path, maxBytes);
    const after = new Set(
      read.kind === "file" ? indexLinkTargets(path, read.bytes.toString("utf8")) : [],
    );
    const removed = base.filter((target) => !after.has(target));
    if (read.kind === "too-large" || removed.length > 0) {
      throw new NavigationCompanionLinkRemovedError(
        path,
        read.kind === "too-large" ? base : removed,
      );
    }
  }
}

/**
 * Label every trigger page that exists after the write and has no path from
 * declared navigation or a root index. The closure follows local Markdown
 * links any number of hops. Automatic navigation reaches every page. Without
 * navigation or an index, or past a bound, the run gets one
 * `navigation-not-checked` label instead of a pass.
 */
export async function documentationReachabilityLabels(input: {
  readonly workspacePath: string;
  readonly plan: AdmittedDocumentationPlanBinding;
  readonly limits?: ResolveLimitsOptions;
}): Promise<readonly NavigationLabelV1[]> {
  const reader = workspaceReader(input.workspacePath);
  const budgets = reachabilityBudgets(input.limits);
  const pages: string[] = [];
  for (const path of companionTriggerPages(input.plan)) {
    const read = await reader.read(path, budgets.maxPageBytes.value);
    if (read.kind !== "absent") pages.push(path);
  }
  if (pages.length === 0) return [];
  // The written tree, not the revision: a page the write linked is reachable.
  const observed = await observeNavigation(reader, budgets);
  const navigation = observed.observation;
  const notChecked = (
    reason: NavigationNotCheckedReason,
    overflow: NavigationLimitOverrunV1 | null,
  ): readonly NavigationLabelV1[] => [
    {
      code: "navigation-not-checked",
      path: null,
      reason,
      navigation: navigation?.path ?? null,
      limit: overflow,
    },
  ];
  if (observed.overflow) return notChecked("limit-exceeded", observed.overflow);
  if (navigation?.mode === "automatic") return [];
  if (navigation?.mode === "unread") return notChecked("navigation-unread", null);
  const indexes = new Map<string, string>();
  for (const root of new Set(pages.map(documentationRoot))) {
    for (const name of DOCUMENTATION_INDEX_NAMES) {
      const path = root ? `${root}/${name}` : name;
      const read = await reader.read(path, budgets.maxPageBytes.value);
      if (read.kind === "too-large") {
        return notChecked("limit-exceeded", overrun(budgets.maxPageBytes, read.byteLength));
      }
      if (read.kind === "file") {
        indexes.set(root, path);
        break;
      }
    }
  }
  const starts = [
    ...(navigation?.mode === "explicit" ? navigation.entries : []),
    ...indexes.values(),
  ];
  if (navigation === null && indexes.size === 0) {
    return notChecked("no-navigation-or-index", null);
  }
  const reached = new Set<string>();
  const queue = [...new Set(starts)];
  while (queue.length > 0) {
    const path = queue.shift()!;
    if (reached.has(path)) continue;
    if (reached.size >= budgets.maxNodes.value) {
      return notChecked("limit-exceeded", overrun(budgets.maxNodes, reached.size + 1));
    }
    reached.add(path);
    if (!MARKDOWN_PAGE.test(path)) continue;
    const read = await reader.read(path, budgets.maxPageBytes.value);
    if (read.kind === "too-large") {
      return notChecked("limit-exceeded", overrun(budgets.maxPageBytes, read.byteLength));
    }
    if (read.kind !== "file") continue;
    for (const target of indexLinkTargets(path, read.bytes.toString("utf8"))) {
      for (const candidate of linkCandidates(target)) {
        if (reached.has(candidate)) break;
        if ((await reader.read(candidate, budgets.maxPageBytes.value)).kind === "absent") continue;
        queue.push(candidate);
        break;
      }
    }
  }
  return pages
    .filter((path) => !reached.has(path))
    .map((path) => ({
      code: "navigation-unreachable-page" as const,
      path,
      navigation: navigation?.path ?? null,
      index: indexes.get(documentationRoot(path)) ?? null,
    }));
}

// ---------------------------------------------------------------------------
// The persisted carrier

const LABEL_KEYS: Readonly<Record<NavigationLabelCode, readonly string[]>> = {
  "navigation-companion-not-granted": ["code", "grant", "path"],
  "navigation-unreachable-page": ["code", "index", "navigation", "path"],
  "navigation-not-checked": ["code", "limit", "navigation", "path", "reason"],
};

function nullablePath(value: unknown): boolean {
  return value === null || (typeof value === "string" && isDocumentationPlanPath(value));
}

/** Whether `value` is one well-formed label; the record readers admit nothing else. */
export function isNavigationLabel(value: unknown): value is NavigationLabelV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const code = item.code as NavigationLabelCode;
  const keys = LABEL_KEYS[code];
  if (!keys || Object.keys(item).sort(compareText).join("\0") !== keys.join("\0")) return false;
  if (code === "navigation-companion-not-granted") {
    return (
      typeof item.path === "string" &&
      isDocumentationPlanPath(item.path) &&
      Array.isArray(item.grant) &&
      item.grant.every((entry) => typeof entry === "string" && entry.length > 0)
    );
  }
  if (code === "navigation-unreachable-page") {
    return (
      typeof item.path === "string" &&
      isDocumentationPlanPath(item.path) &&
      nullablePath(item.navigation) &&
      nullablePath(item.index)
    );
  }
  const overflow = item.limit as Record<string, unknown> | null;
  return (
    item.path === null &&
    (NAVIGATION_NOT_CHECKED_REASONS as readonly unknown[]).includes(item.reason) &&
    nullablePath(item.navigation) &&
    (overflow === null ||
      (!!overflow &&
        typeof overflow === "object" &&
        Object.keys(overflow).sort(compareText).join("\0") === "name\0observed\0value" &&
        // Only a catalogued name: the summary reads its refusal and remediation.
        typeof overflow.name === "string" &&
        Object.hasOwn(LIMIT_DEFINITION_BY_NAME, overflow.name) &&
        Number.isSafeInteger(overflow.observed) &&
        Number.isSafeInteger(overflow.value))) &&
    (item.reason === "limit-exceeded") === (overflow !== null)
  );
}

/** Whether `value` is a step's navigation label list as the host records it. */
export function isNavigationLabelList(value: unknown): value is readonly NavigationLabelV1[] {
  return Array.isArray(value) && value.length > 0 && value.every(isNavigationLabel);
}

/** The operator sentence for one label, built from its structured fields only. */
export function navigationLabelSummary(label: NavigationLabelV1): string {
  if (label.code === "navigation-companion-not-granted") {
    return (
      `${label.path} lists or links the run's new pages, but the run's write grant ` +
      `(${label.grant.join(", ") || "none"}) does not cover it, so it was not edited. ` +
      `Add entries for the new pages to ${label.path} in a follow-up change.`
    );
  }
  if (label.code === "navigation-unreachable-page") {
    const from = [label.navigation, label.index].filter((path) => path !== null).join(" or ");
    return (
      `${label.path} received new content, but no link path reaches it from ${from}. ` +
      `Link it from the index or add it to the navigation.`
    );
  }
  if (label.reason === "limit-exceeded" && label.limit) {
    // The decoder admits catalogued names only; the value is the run's effective one.
    const definition = LIMIT_DEFINITION_BY_NAME[label.limit.name]!;
    return (
      "Reachability of the run's new pages was not checked. " +
      formatLimitObservation({ ...definition, value: label.limit.value }, label.limit.observed)
    );
  }
  if (label.reason === "navigation-unread") {
    return (
      `Reachability of the run's new pages was not checked: ${label.navigation ?? "the navigation"} ` +
      "is navigation this check does not read. Confirm the new pages are listed there."
    );
  }
  return (
    "Reachability of the run's new pages was not checked: the repository declares no " +
    "navigation and the pages' root has no index. Link the new pages from an index page."
  );
}
