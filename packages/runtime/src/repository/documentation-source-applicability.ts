// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { canonicalDigest, sha256 } from "../content-ir/canonical.js";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { createContractKit, type ContractFail } from "../contract-kit/index.js";
import { DurableArtifactStore } from "../artifacts/store.js";
import {
  fernHasVersionIndex,
  fernNavigationTargets,
  fernRoutePrefixes,
  fernVersionNavigationPaths,
} from "./fern-navigation.js";
import {
  DOCUMENTATION_SOURCE_ADAPTER_IDS,
  DOCUMENTATION_SOURCE_ADAPTER_VERSION,
  DOCUMENTATION_SOURCE_CONFIGURATION_LOCATIONS,
  DOCUMENTATION_SOURCE_LIMITATION_CODES,
  DOCUMENTATION_SOURCE_NAVIGATION_MODES,
  canonicalDocumentationSourcePath,
  documentationMarkdownLinkTargets,
  fernCanonicalTargets,
  fernRouteAliases,
  type DocumentationSourceAdapterId,
  type DocumentationSourceLimitationCode,
  type DocumentationSourceNavigationMode,
  documentationSourceAdapterForConfiguration,
  resolveDocumentationSourceAdapter,
  documentationSourceLimitationForAdapter,
  documentationSourceValidationAdapter,
  isDocumentationMarkupPath,
  isDocumentationSourceConfigurationPath,
} from "./documentation-source-support.js";

export const DOCUMENTATION_SOURCE_APPLICABILITY_KIND =
  "docsfab-documentation-source-applicability" as const;

export const DOCUMENTATION_CHANGED_PATH_STATUSES = [
  "added",
  "modified",
  "deleted",
  "renamed",
  "copied",
] as const;
export type DocumentationChangedPathStatus = (typeof DOCUMENTATION_CHANGED_PATH_STATUSES)[number];

export type DocumentationSourceConfigurationV1 = Readonly<{
  path: string;
  sha256: string;
}>;

export type DocumentationSourceApplicabilityRootV1 = Readonly<{
  root: string;
  adapterId: DocumentationSourceAdapterId;
  adapterVersion: typeof DOCUMENTATION_SOURCE_ADAPTER_VERSION;
  configurationFiles: readonly DocumentationSourceConfigurationV1[];
  navigationMode: DocumentationSourceNavigationMode;
  requiredPathClosureSha256: string;
  limitations: readonly DocumentationSourceLimitationCode[];
}>;

export interface DocumentationSourceApplicabilityV1 {
  readonly schemaVersion: 1;
  readonly kind: typeof DOCUMENTATION_SOURCE_APPLICABILITY_KIND;
  readonly repositoryIdentitySha256: string;
  readonly baseRevision: string;
  readonly candidateInputTreeSha256: string;
  readonly changedPaths: readonly Readonly<{
    path: string;
    status: DocumentationChangedPathStatus;
  }>[];
  readonly roots: readonly DocumentationSourceApplicabilityRootV1[];
  readonly applicabilitySha256: string;
}

export type DocumentationSourceApplicabilityInputV1 = Omit<
  DocumentationSourceApplicabilityV1,
  "schemaVersion" | "kind" | "applicabilitySha256"
>;

export type DocumentationSourceApplicabilityErrorCode =
  | "invalid-shape"
  | "invalid-value"
  | "digest-mismatch"
  | "credential-material"
  | "schema-mismatch";

export class DocumentationSourceApplicabilityError extends Error {
  public constructor(public readonly code: DocumentationSourceApplicabilityErrorCode) {
    super(`The documentation source applicability contract rejected this value (${code}).`);
    this.name = "DocumentationSourceApplicabilityError";
  }
}

function fail(code: DocumentationSourceApplicabilityErrorCode): never {
  throw new DocumentationSourceApplicabilityError(code);
}

const kit = createContractKit({
  fail: fail as ContractFail<DocumentationSourceApplicabilityErrorCode>,
  inertMode: "strict",
  codes: {
    invalidShape: "invalid-shape",
    invalidValue: "invalid-value",
    digestMismatch: "digest-mismatch",
    credentialMaterial: "credential-material",
    schemaMismatch: "schema-mismatch",
  },
});

const SHA256 = /^[a-f0-9]{64}$/u;
const REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

export function createDocumentationSourceApplicability(
  input: DocumentationSourceApplicabilityInputV1,
): DocumentationSourceApplicabilityV1 {
  const body = canonicalBody(input);
  const record = kit.deepFreeze({
    schemaVersion: 1 as const,
    kind: DOCUMENTATION_SOURCE_APPLICABILITY_KIND,
    ...body,
    applicabilitySha256: canonicalDigest({
      schemaVersion: 1,
      kind: DOCUMENTATION_SOURCE_APPLICABILITY_KIND,
      ...body,
    }),
  });
  assertDocumentationSourceApplicability(record);
  return record;
}

export function assertDocumentationSourceApplicability(
  value: unknown,
): asserts value is DocumentationSourceApplicabilityV1 {
  const root = kit.object(value);
  kit.exact(root, [
    "schemaVersion",
    "kind",
    "repositoryIdentitySha256",
    "baseRevision",
    "candidateInputTreeSha256",
    "changedPaths",
    "roots",
    "applicabilitySha256",
  ]);
  if (root.schemaVersion !== 1 || root.kind !== DOCUMENTATION_SOURCE_APPLICABILITY_KIND)
    fail("schema-mismatch");
  const body = canonicalBody({
    repositoryIdentitySha256: kit.hash(root.repositoryIdentitySha256),
    baseRevision: kit.string(root.baseRevision),
    candidateInputTreeSha256: kit.hash(root.candidateInputTreeSha256),
    changedPaths: kit.array(
      root.changedPaths,
    ) as DocumentationSourceApplicabilityInputV1["changedPaths"],
    roots: kit.array(root.roots) as DocumentationSourceApplicabilityInputV1["roots"],
  });
  const expected = canonicalDigest({
    schemaVersion: 1,
    kind: DOCUMENTATION_SOURCE_APPLICABILITY_KIND,
    ...body,
  });
  if (kit.hash(root.applicabilitySha256) !== expected) fail("digest-mismatch");
  kit.assertInert(value);
  kit.rejectCredentials(value);
}

export function decodeDocumentationSourceApplicability(
  value: unknown,
): DocumentationSourceApplicabilityV1 {
  assertDocumentationSourceApplicability(value);
  return kit.deepFreeze(value);
}

export async function storeDocumentationSourceApplicability(
  store: DurableArtifactStore,
  value: DocumentationSourceApplicabilityV1,
): Promise<void> {
  assertDocumentationSourceApplicability(value);
  await store.putRecord(value.applicabilitySha256, value);
  decodeDocumentationSourceApplicability(await store.getRecord(value.applicabilitySha256));
}

export async function loadDocumentationSourceApplicability(
  store: DurableArtifactStore,
  applicabilitySha256: string,
): Promise<DocumentationSourceApplicabilityV1> {
  if (!SHA256.test(applicabilitySha256)) fail("invalid-value");
  const record = decodeDocumentationSourceApplicability(await store.getRecord(applicabilitySha256));
  if (record.applicabilitySha256 !== applicabilitySha256) fail("digest-mismatch");
  return record;
}

export interface DeriveDocumentationSourceApplicabilityInput {
  readonly candidateRoot: string;
  readonly repositoryIdentitySha256: string;
  readonly baseRevision: string;
  readonly candidateInputTreeSha256: string;
  readonly changedPaths: readonly Readonly<{
    path: string;
    status: DocumentationChangedPathStatus;
  }>[];
  /** Verified base configuration paths used to detect deletion-based downgrade attempts. */
  readonly baseConfigurationPaths?: readonly string[];
  readonly authorizedRootConfigurationChange?: boolean;
}

/** Derive the plain/Fern facade from candidate bytes. Other slots remain limitations. */
export async function deriveDocumentationSourceApplicability(
  input: DeriveDocumentationSourceApplicabilityInput,
): Promise<DocumentationSourceApplicabilityV1> {
  const rootDirectory = resolve(input.candidateRoot);
  const changedPaths = [...input.changedPaths].sort(compareChangedPath);
  const baseConfigurationPaths = (input.baseConfigurationPaths ?? []).filter(
    isDocumentationSourceConfigurationPath,
  );
  const relevant = changedPaths.filter(
    ({ path }) => isDocumentationMarkupPath(path) || isDocumentationSourceConfigurationPath(path),
  );
  const rootNames = new Set(
    relevant.map(({ path }) => {
      const parts = path.split("/");
      return parts[0] === "packages" && parts.length > 2 ? `packages/${parts[1]}` : ".";
    }),
  );
  const roots: DocumentationSourceApplicabilityRootV1[] = [];
  for (const root of [...rootNames].sort()) {
    const rootChanged = relevant.filter(({ path }) => documentationRootForPath(path) === root);
    const configurationCandidates = configurationLocations(root);
    const presentConfigurationFiles: DocumentationSourceConfigurationV1[] = [];
    for (const path of configurationCandidates) {
      const bytes = await readCandidateBytes(rootDirectory, path);
      if (bytes) presentConfigurationFiles.push({ path, sha256: sha256(bytes) });
    }
    const explicitAdapters = rootOwners(
      presentConfigurationFiles.map(({ path }) => configurationAdapter(root, path)),
    );
    const configurationFiles = presentConfigurationFiles.filter(({ path }) =>
      explicitAdapters.has(configurationAdapter(root, path)),
    );
    let adapterId: DocumentationSourceAdapterId = "plain-markdown";
    const limitations: DocumentationSourceLimitationCode[] = [];
    if (explicitAdapters.size === 1) adapterId = [...explicitAdapters][0] ?? adapterId;
    else if (explicitAdapters.size > 1)
      limitations.push("ambiguous-root-ownership", "unsupported-relevant-configuration");
    // A partial validate capability is checked by its fallback adapter's rules.
    const validationAdapterId = documentationSourceValidationAdapter(adapterId);
    if (
      (explicitAdapters.size === 0 || validationAdapterId !== adapterId) &&
      rootChanged.some(
        ({ path }) =>
          isDocumentationMarkupPath(path) &&
          !adapterSupportsExtension(validationAdapterId, stripRoot(root, path)),
      )
    )
      limitations.push("unrecognized-markup-extension");
    if (
      explicitAdapters.size === 1 &&
      rootChanged.some(({ path }) => {
        const strippedPath = stripRoot(root, path);
        return (
          isDocumentationMarkupPath(path) &&
          adapterSupportsExtension(validationAdapterId, strippedPath) &&
          !adapterOwnsMarkupPath(validationAdapterId, strippedPath)
        );
      })
    )
      limitations.push("mixed-root-ownership");
    const adapterLimitation = documentationSourceLimitationForAdapter(adapterId);
    if (adapterLimitation) limitations.push(adapterLimitation);
    // Deleting a fallback adapter's configuration cannot weaken validation: its
    // root was already checked as plain Markdown.
    const baseDeleted = baseConfigurationPaths.some(
      (path) =>
        documentationRootForPath(path) === root &&
        documentationSourceValidationAdapter(configurationAdapter(root, path)) ===
          configurationAdapter(root, path) &&
        !presentConfigurationFiles.some((item) => item.path === path),
    );
    if (baseDeleted && !input.authorizedRootConfigurationChange)
      limitations.push("configuration-deleted-without-authorized-root-change");
    const closure = await collectDocumentationRequiredPathClosure(
      root === "." ? rootDirectory : resolve(rootDirectory, root),
      rootChanged.map(({ path, status }) => ({ path: stripRoot(root, path), status })),
      configurationFiles.map(({ path }) => stripRoot(root, path)),
      validationAdapterId,
    );
    roots.push({
      root,
      adapterId,
      adapterVersion: DOCUMENTATION_SOURCE_ADAPTER_VERSION,
      configurationFiles,
      navigationMode:
        resolveDocumentationSourceAdapter(adapterId).capabilities.navigation === "not-applicable"
          ? "none"
          : "explicit",
      requiredPathClosureSha256: canonicalDigest(closure),
      limitations: [...new Set(limitations)].sort(),
    });
  }
  return createDocumentationSourceApplicability({
    repositoryIdentitySha256: input.repositoryIdentitySha256,
    baseRevision: input.baseRevision,
    candidateInputTreeSha256: input.candidateInputTreeSha256,
    changedPaths,
    roots,
  });
}

/** Registry order is byte order, which `configurationFiles` must keep. */
function configurationLocations(root: string): string[] {
  const prefix = root === "." ? "" : `${root}/`;
  return DOCUMENTATION_SOURCE_CONFIGURATION_LOCATIONS.map((location) => `${prefix}${location}`);
}

function configurationAdapter(root: string, path: string): DocumentationSourceAdapterId {
  return documentationSourceAdapterForConfiguration(stripRoot(root, path)) ?? "plain-markdown";
}

/**
 * The adapters that own a root. An adapter validated through a fallback yields
 * to one that validates natively, so a Sphinx `conf.py` beside a
 * sphinx-external-toc `_toc.yml` stays a Sphinx root, as it was before Jupyter
 * Book was registered.
 */
function rootOwners(
  adapters: readonly DocumentationSourceAdapterId[],
): ReadonlySet<DocumentationSourceAdapterId> {
  const native = adapters.filter(
    (adapterId) => documentationSourceValidationAdapter(adapterId) === adapterId,
  );
  return new Set(native.length > 0 ? native : adapters);
}

function stripRoot(root: string, path: string): string {
  return root === "." ? path : path.slice(root.length + 1);
}

function documentationRootForPath(path: string): string {
  const parts = path.split("/");
  return parts[0] === "packages" && parts.length > 2 ? `packages/${parts[1]}` : ".";
}

function adapterOwnsMarkupPath(adapterId: DocumentationSourceAdapterId, path: string): boolean {
  if (adapterId === "plain-markdown") return true;
  if (adapterId === "fern") return path.startsWith("docs/") || path.startsWith("fern/pages/");
  if (adapterId === "mkdocs" || adapterId === "docusaurus") return path.startsWith("docs/");
  return path.startsWith("docs/");
}

/** Whether the adapter can parse this extension at all, regardless of location. */
function adapterSupportsExtension(adapterId: DocumentationSourceAdapterId, path: string): boolean {
  return resolveDocumentationSourceAdapter(adapterId).supportedExtensions.some((extension) =>
    path.toLowerCase().endsWith(extension),
  );
}
async function collectDocumentationRequiredPathClosure(
  candidateRoot: string,
  changedPaths: readonly Readonly<{
    path: string;
    status: DocumentationChangedPathStatus;
  }>[],
  configurationPaths: readonly string[],
  adapterId: DocumentationSourceAdapterId,
): Promise<readonly Readonly<{ path: string; sha256: string | null }>[]> {
  const root = resolve(candidateRoot);
  const closure = new Map<string, string | null>();
  const markdown = changedPaths
    .filter(({ path, status }) => status !== "deleted" && isDocumentationMarkupPath(path))
    .map(({ path }) => path);
  for (const { path, status } of changedPaths)
    await recordClosurePath(root, path, closure, status === "deleted");
  for (const path of configurationPaths) await recordClosurePath(root, path, closure, false);

  const routeMap = new Map<string, string>();
  if (adapterId === "fern") {
    const navigationPaths = new Set(configurationPaths.filter(isFernNavigationPath));
    let prefixes = [""];
    for (const configurationPath of navigationPaths) {
      if (!/^fern\/docs\.ya?ml$/u.test(configurationPath)) continue;
      const source = await readClosureSource(root, configurationPath);
      if (source === undefined) continue;
      try {
        prefixes = fernRoutePrefixes(source);
      } catch {
        // The governing bytes are bound; structural validation reports malformed navigation.
      }
    }
    for (const { path, status } of changedPaths)
      if (status !== "deleted" && isFernNavigationPath(path)) navigationPaths.add(path);
    for (const path of [...navigationPaths]) {
      const source = await readClosureSource(root, path);
      if (source === undefined) continue;
      try {
        for (const nested of fernVersionNavigationPaths(resolve(root, path), source)) {
          const nestedPath = relative(root, nested).replaceAll("\\", "/");
          if (isFernNavigationPath(nestedPath)) navigationPaths.add(nestedPath);
        }
      } catch {
        // The governing bytes are bound; structural validation reports malformed navigation.
      }
    }
    for (const path of navigationPaths) {
      await recordClosurePath(root, path, closure, false);
      const source = await readClosureSource(root, path);
      if (source === undefined) continue;
      try {
        if (fernHasVersionIndex(source)) continue;
        const targets = fernNavigationTargets(source);
        const aliases = await fernRouteAliases(root, resolve(root, path), targets, prefixes);
        for (const [route, target] of aliases.routes) routeMap.set(route, target);
        for (const target of targets) {
          const pages = await closureTargetPaths(
            root,
            resolve(dirname(resolve(root, path)), target.path),
          );
          if (pages.length === 0) {
            closure.set(closureMissingMarker(path, target.path), null);
            continue;
          }
          for (const page of pages) {
            const pagePath = relative(root, page).replaceAll("\\", "/");
            await recordClosurePath(root, pagePath, closure, false);
            const pageSource = await readClosureSource(root, pagePath);
            if (pageSource === undefined) continue;
            for (const canonical of fernCanonicalTargets(pageSource))
              await recordClosureTarget(root, pagePath, canonical, new Map(), closure);
          }
        }
      } catch {
        // The governing bytes are bound; structural validation reports malformed navigation.
      }
    }
  }

  for (const path of markdown) {
    const source = await readClosureSource(root, path);
    if (source === undefined) continue;
    for (const target of documentationMarkdownLinkTargets(source))
      await recordClosureTarget(root, path, target, routeMap, closure);
  }
  return [...closure]
    .map(([path, digest]) => ({ path, sha256: digest }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

function isFernNavigationPath(path: string): boolean {
  return /^fern\/(?:docs|versions\/[^/]+)\.ya?ml$/u.test(path);
}

async function recordClosureTarget(
  root: string,
  sourcePath: string,
  rawTarget: string,
  routeMap: ReadonlyMap<string, string>,
  closure: Map<string, string | null>,
): Promise<void> {
  const target = rawTarget.split("#", 1)[0] ?? "";
  if (!target || /^(?:https?:|mailto:|tel:|#)/iu.test(target)) return;
  if (target.startsWith("/")) {
    const mapped = routeMap.get(target);
    if (mapped) {
      await recordClosurePath(root, relative(root, mapped).replaceAll("\\", "/"), closure, false);
      return;
    }
    closure.set(closureMissingMarker(sourcePath, target), null);
    return;
  }
  if (target.includes("\\")) {
    closure.set(closureMissingMarker(sourcePath, target), null);
    return;
  }
  const pages = await closureTargetPaths(root, resolve(dirname(resolve(root, sourcePath)), target));
  if (pages.length === 0) {
    closure.set(closureMissingMarker(sourcePath, target), null);
    return;
  }
  for (const page of pages)
    await recordClosurePath(root, relative(root, page).replaceAll("\\", "/"), closure, false);
}

async function closureTargetPaths(root: string, resolved: string): Promise<string[]> {
  if (!withinRoot(root, resolved)) return [];
  try {
    await assertSafeClosurePath(root, resolved);
    const info = await stat(resolved);
    if (info.isFile()) return [resolved];
    if (info.isDirectory()) return closureMarkdownFiles(root, resolved);
  } catch {
    // Extension and index candidates preserve the structural validator's finite order.
  }
  for (const candidate of [
    `${resolved}.md`,
    `${resolved}.mdx`,
    join(resolved, "index.mdx"),
    join(resolved, "index.md"),
    join(resolved, "_index.md"),
  ]) {
    try {
      await assertSafeClosurePath(root, candidate);
      if ((await stat(candidate)).isFile()) return [candidate];
    } catch {
      // Try the next candidate.
    }
  }
  return [];
}

async function closureMarkdownFiles(root: string, directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    await assertSafeClosurePath(root, path);
    if (entry.isDirectory()) result.push(...(await closureMarkdownFiles(root, path)));
    else if (/\.mdx?$/u.test(entry.name)) result.push(path);
  }
  return result;
}

async function recordClosurePath(
  root: string,
  path: string,
  closure: Map<string, string | null>,
  missing: boolean,
): Promise<void> {
  if (missing) {
    closure.set(path, null);
    return;
  }
  try {
    const candidate = resolve(root, canonicalDocumentationSourcePath(path));
    await assertSafeClosurePath(root, candidate);
    closure.set(path, sha256(await readFile(candidate)));
  } catch {
    closure.set(path, null);
  }
}

async function readClosureSource(root: string, path: string): Promise<string | undefined> {
  try {
    const candidate = resolve(root, canonicalDocumentationSourcePath(path));
    await assertSafeClosurePath(root, candidate);
    return await readFile(candidate, "utf8");
  } catch {
    return undefined;
  }
}

async function assertSafeClosurePath(root: string, path: string): Promise<void> {
  if (!withinRoot(root, path))
    throw new Error("Documentation closure paths must remain within the real candidate root.");
  let current = root;
  for (const segment of relative(root, path).split(/[\\/]/u).filter(Boolean)) {
    current = join(current, segment);
    if ((await lstat(current)).isSymbolicLink())
      throw new Error("Documentation closure paths must remain within the real candidate root.");
  }
  if (!withinRoot(await realpath(root), await realpath(path)))
    throw new Error("Documentation closure paths must remain within the real candidate root.");
}

function withinRoot(root: string, path: string): boolean {
  const value = relative(root, path);
  return (
    value === "" || (!value.startsWith("..") && !value.includes("../") && !value.includes("..\\"))
  );
}

function closureMissingMarker(sourcePath: string, target: string): string {
  return `missing:${sourcePath}:${target}`;
}

async function readCandidateBytes(root: string, path: string): Promise<Buffer | undefined> {
  const target = join(root, canonicalDocumentationSourcePath(path));
  if (!target.startsWith(`${root}/`)) fail("invalid-value");
  try {
    if (!(await stat(target)).isFile()) return undefined;
    return await readFile(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function compareChangedPath(
  left: Readonly<{ path: string; status: DocumentationChangedPathStatus }>,
  right: Readonly<{ path: string; status: DocumentationChangedPathStatus }>,
): number {
  return left.path < right.path
    ? -1
    : left.path > right.path
      ? 1
      : left.status.localeCompare(right.status);
}

function canonicalBody(input: DocumentationSourceApplicabilityInputV1) {
  if (!SHA256.test(input.repositoryIdentitySha256)) fail("invalid-value");
  if (!REVISION.test(input.baseRevision)) fail("invalid-value");
  if (!SHA256.test(input.candidateInputTreeSha256)) fail("invalid-value");
  if (!Array.isArray(input.changedPaths)) fail("invalid-shape");
  const changedPaths = input.changedPaths.map((entry) => {
    const row = kit.object(entry);
    kit.exact(row, ["path", "status"]);
    return {
      path: canonicalDocumentationSourcePath(kit.string(row.path)),
      status: kit.enumeration(row.status, DOCUMENTATION_CHANGED_PATH_STATUSES),
    };
  });
  assertSortedUnique(changedPaths.map(({ path, status }) => `${path}\0${status}`));
  const roots = kit.array(input.roots).map((entry) => canonicalRoot(entry));
  assertSortedUnique(roots.map(({ root }) => root));
  return {
    repositoryIdentitySha256: input.repositoryIdentitySha256,
    baseRevision: input.baseRevision,
    candidateInputTreeSha256: input.candidateInputTreeSha256,
    changedPaths,
    roots,
  };
}

function canonicalRoot(value: unknown): DocumentationSourceApplicabilityRootV1 {
  const root = kit.object(value);
  kit.exact(root, [
    "root",
    "adapterId",
    "adapterVersion",
    "configurationFiles",
    "navigationMode",
    "requiredPathClosureSha256",
    "limitations",
  ]);
  const configurationFiles = kit.array(root.configurationFiles).map((entry) => {
    const row = kit.object(entry);
    kit.exact(row, ["path", "sha256"]);
    return {
      path: canonicalDocumentationSourcePath(kit.string(row.path)),
      sha256: kit.hash(row.sha256),
    };
  });
  assertSortedUnique(configurationFiles.map(({ path }) => path));
  const limitations = kit
    .array(root.limitations)
    .map((entry) => kit.enumeration(entry, DOCUMENTATION_SOURCE_LIMITATION_CODES));
  assertSortedUnique(limitations);
  return {
    root: canonicalRootPath(kit.string(root.root)),
    adapterId: kit.enumeration(root.adapterId, DOCUMENTATION_SOURCE_ADAPTER_IDS),
    adapterVersion: kit.enumeration(root.adapterVersion, [
      DOCUMENTATION_SOURCE_ADAPTER_VERSION,
    ] as const),
    configurationFiles,
    navigationMode: kit.enumeration(root.navigationMode, DOCUMENTATION_SOURCE_NAVIGATION_MODES),
    requiredPathClosureSha256: kit.hash(root.requiredPathClosureSha256),
    limitations,
  };
}

function canonicalRootPath(value: string): string {
  if (value === ".") return value;
  return canonicalDocumentationSourcePath(value);
}

function assertSortedUnique(values: readonly string[]): void {
  for (let index = 0; index < values.length; index += 1) {
    if (index > 0 && (values[index - 1] ?? "") >= (values[index] ?? "")) fail("invalid-value");
  }
}
