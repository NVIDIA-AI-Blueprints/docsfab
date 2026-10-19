// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { lstatSync, type Dirent } from "node:fs";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, posix, relative, resolve, sep } from "node:path";
import {
  isAlias,
  isMap,
  isScalar,
  isSeq,
  parseDocument as parseYamlDocument,
  visit as visitYaml,
} from "yaml";

import {
  listTrackedRepositoryEntries,
  listTrackedRepositoryFiles,
  readTrackedRepositoryFile,
  trackedRepositoryEntryKind,
} from "../repository/workspace/tracked-read.js";
import { RepositoryWorkspaceReadError } from "../repository/workspace/contracts.js";

import { canonicalDigest, sha256 } from "./canonical.js";
import { enrichMystV3, maskInlineCode, parseRstDocument } from "./parser.js";
import type {
  BuildContentIndexInput,
  BuildScopedContentIndexInput,
  BuildContentIndexV2Input,
  BuildContentIndexV3Input,
  CodeBlockShape,
  ContentFormat,
  ContentFormatV3,
  ContentIndexV1,
  ContentIndexV2,
  ContentIndexV3,
  ContentNode,
  ContentNodeV3,
  DirectiveShape,
  DocumentNode,
  DocumentNodeV3,
  FrontmatterFieldShape,
  PageAnchorRefusalCode,
  ScopedContentIndexResult,
  ScopedIndexCoverage,
  SectionNode,
  StructuralEdge,
  StructuralEdgeV2,
} from "./contracts.js";
import {
  CONTENT_INDEX_ASSET_WARNING_CODE,
  CONTENT_INDEX_INCOMPLETE_WARNING_CODE,
  CONTENT_INDEX_NAME_WARNING_CODE,
  ContentIndexError,
} from "./contracts.js";
import { formatLimitObservation, resolveLimits, type ResolvedLimit } from "../config/limits.js";
import { escapeCodePoint, escapeUndisplayable } from "../shared/display-text.js";
import { compareText, isRecord } from "../shared/primitives.js";

const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const MARKDOWN_EXTENSION = /\.(?:md|mdx)$/iu;
const RST_EXTENSION = /\.rst$/iu;
const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)\s*$/u;
const ATX_HEADING_START = /^ {0,3}#{1,6}(?:[ \t]|$)/u;
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/u;
const BLOCK_QUOTE_START = /^ {0,3}>/u;
const LIST_ITEM_START = /^ {0,3}(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)/u;
/** A MyST colon fence; code fences never reach the paragraph check. */
const COLON_FENCE = /^\s*:{3,}/u;
const INDENTED_CODE = /^(?: {0,3}\t| {4})/u;
/** CommonMark HTML block type 6 tag names. */
const HTML_BLOCK_TAG_NAMES =
  "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";
/** CommonMark HTML block starts that can interrupt a paragraph: types 1 to 6. */
const HTML_BLOCK_START = new RegExp(
  String.raw`^ {0,3}(?:<(?:pre|script|style|textarea)(?:[ \t>]|$)|<!--|<\?|<![A-Za-z]|<!\[CDATA\[|</?(?:${HTML_BLOCK_TAG_NAMES})(?:[ \t>]|/>|$))`,
  "iu",
);
/**
 * A line holding only HTML or JSX tags at any indentation, such as `</div>`,
 * `</Note>`, or `<Tabs.Item value={x}>`; never heading text.
 */
const TAG_ONLY_LINE = /^[ \t]*(?:<\/?[A-Za-z][^<>]*>[ \t]*)+$/u;
/** The YAML 1.1 merge key tag, `<<`. */
const YAML_MERGE_TAG = "tag:yaml.org,2002:merge";
/** The YAML 1.1 ordered map tag, `!!omap`, which the library checks in quadratic time. */
const YAML_OMAP_TAG = "tag:yaml.org,2002:omap";
const NAVIGATION_NAMES = new Set([
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
export const EXCLUDED_DIRECTORIES = new Set([".git", ".docsfab", "node_modules", "dist", "build"]);
// Repository-level evaluation corpora, governed asset bundles, and executable
// skill packs are inputs to DocsFab rather than product documentation. A
// directly selected root remains fully indexed, as do nested docs using these
// otherwise-valid directory names.
const EXCLUDED_ROOT_DIRECTORIES = new Set(["evaluation", "governed-assets", "skills"]);
/** Nested quality/benchmarks/fixtures corpora are not product documentation. */
const EXCLUDED_INPUT_CORPUS_SEGMENTS = new Set(["benchmarks", "fixtures"]);
/** The declared content index limits (config/limits/contentIndex.yaml), overrides applied. */
export interface ContentIndexLimits {
  /** Distinct linked assets one workspace index hashes. */
  readonly maxAssets: ResolvedLimit;
  /** Bytes of one linked asset. */
  readonly maxAssetBytes: ResolvedLimit;
  /** Combined bytes of the linked assets. */
  readonly maxTotalAssetBytes: ResolvedLimit;
  /** Bytes of one page or navigation source a workspace index parses. */
  readonly maxSourceBytes: ResolvedLimit;
}

const CONTENT_INDEX_LIMIT_NAMES = Object.freeze({
  maxAssets: "contentIndex.maxAssets",
  maxAssetBytes: "contentIndex.maxAssetBytes",
  maxTotalAssetBytes: "contentIndex.maxTotalAssetBytes",
  maxSourceBytes: "contentIndex.maxSourceBytes",
} as const);

/** Resolves the content index limits once, as a host or project override sets them. */
export function resolveContentIndexLimits(): ContentIndexLimits {
  const resolved = resolveLimits();
  const pick = (name: string): ResolvedLimit => {
    const entry = resolved.find((candidate) => candidate.name === name);
    if (!entry) {
      throw new Error(`Unknown operational limit ${name} is not declared in config/limits.yaml.`);
    }
    return entry;
  };
  return {
    maxAssets: pick(CONTENT_INDEX_LIMIT_NAMES.maxAssets),
    maxAssetBytes: pick(CONTENT_INDEX_LIMIT_NAMES.maxAssetBytes),
    maxTotalAssetBytes: pick(CONTENT_INDEX_LIMIT_NAMES.maxTotalAssetBytes),
    maxSourceBytes: pick(CONTENT_INDEX_LIMIT_NAMES.maxSourceBytes),
  };
}

interface Heading {
  anchor: string;
  depth: number;
  line: number;
  endLine: number;
  id: string;
  textDigest: string;
}

interface ParsedLink {
  line: number;
  target: string;
  intent: "link" | "image";
  role?: "ref" | "doc";
}

interface ReferenceLinkUse {
  line: number;
  label: string;
  intent: "link" | "image";
}

interface ParsedDocument {
  sourcePath: string;
  id: string;
  format: ContentFormat;
  byteLength: number;
  anchors: string[];
  frontmatter: FrontmatterFieldShape[];
  directives: DirectiveShape[];
  codeBlocks: CodeBlockShape[];
  headings: Heading[];
  links: ParsedLink[];
  bodyDigest: string;
  headingsDigest: string;
  metadataDigest: string;
}

type ParsedDocumentV3 = Omit<ParsedDocument, "format"> & { format: ContentFormatV3 };

interface SourceFile {
  path: string;
  contents: string;
  contentSha256: string;
  byteLength: number;
}

interface AssetSource {
  path: string;
  contentSha256: string;
}

interface AssetBudget {
  totalBytes: number;
  /** The declared limits, resolved once for this index. */
  readonly limits: ContentIndexLimits;
  /** Assets left out past a limit; each is named once. */
  readonly leftOut: Set<string>;
  readonly limitations: ContentIndexLimitation[];
}

/**
 * Why the index left a linked asset out: the asset limit it would pass. The
 * reason type, the run-warning filter, and the operator sentence all read this
 * one list, so a reason dropped from it no longer type-checks where the index
 * records it.
 */
const ASSET_LIMITATION_REASON_LIST = [
  "asset-count-exceeded",
  "asset-too-large",
  "asset-bytes-exceeded",
] as const;
type AssetLimitationReason = (typeof ASSET_LIMITATION_REASON_LIST)[number];

/** An anchor a page cannot admit: the coded stop it is on a target page. */
interface PageAnchorProblem {
  readonly code: PageAnchorRefusalCode;
  /** The line of the heading, explicit anchor, MyST label, or HTML id. */
  readonly line: number;
  /** Names the page, the line, and the edit. */
  readonly message: string;
}

/**
 * Records a page anchor problem instead of stopping. Absent, the problem
 * stops the index with its code: the page is a target.
 */
type PageAnchorRecorder = (problem: PageAnchorProblem) => void;

export async function buildContentIndex(input: BuildContentIndexInput): Promise<ContentIndexV1> {
  const discovered = await discoverIndexSources(input, undefined);
  return compileDiscoveredIndexV1(input, discovered, undefined);
}

/**
 * Focused index for selected targets. Relevance classes, decided before any
 * symlink is rejected:
 * (a) a selected target, or a directory on its path: an alias is refused and
 *     reported, never followed;
 * (b) a navigation source on a target's ancestor chain is required: an alias
 *     or unsupported shape is reported as incomplete navigation coverage;
 * (c) any other page beside the ancestor chain is optional: an alias is
 *     skipped and reported, and never degrades coverage;
 * (d) entries of a directory no target needs are never read.
 * Navigation entries naming a page outside the include set are counted as
 * out of scope, and entries naming a skipped (c) alias are counted as alias
 * entries, instead of being reported as broken. Both break the chain.
 */
export async function buildScopedContentIndex(
  input: BuildScopedContentIndexInput,
): Promise<ScopedContentIndexResult> {
  // An empty target list selects nothing: only the repository root is read.
  const includePaths = [...new Set(input.includePaths.map((path) => requestedPathKey(path)))].sort(
    compareText,
  );
  const trackedAliasesByDirectory = new Map<string, Set<string>>();
  for (const raw of input.trackedAliasPaths ?? []) {
    const path = requestedPathKey(raw);
    const directory = parentPosix(path);
    const names = trackedAliasesByDirectory.get(directory) ?? new Set<string>();
    names.add(path.slice(directory ? directory.length + 1 : 0));
    trackedAliasesByDirectory.set(directory, names);
  }
  const scope: FocusedScopeState = {
    includePaths,
    trackedAliasesByDirectory,
    coverage: {
      refusedAliasPaths: [],
      incompleteNavigationPaths: [],
      skippedOptionalAliasPaths: [],
      outOfScopeNavigationTargets: 0,
      aliasNavigationTargets: 0,
    },
  };
  const scopedInput = { ...input, includePaths };
  const discovered = await discoverIndexSources(scopedInput, scope);
  if (scope.coverage.refusedAliasPaths.length > 0) {
    // Refuse before reading any source bytes: a selected path that is an
    // alias names content outside the reviewed tree entry.
    return { status: "alias-refused", coverage: sortedCoverage(scope.coverage) };
  }
  const index = await compileDiscoveredIndexV1(scopedInput, discovered, scope);
  return { status: "indexed", index, coverage: sortedCoverage(scope.coverage) };
}

interface FocusedScopeState {
  readonly includePaths: readonly string[];
  readonly trackedAliasesByDirectory: ReadonlyMap<string, ReadonlySet<string>>;
  readonly coverage: ScopedIndexCoverage;
}

/**
 * One page or navigation source the walk found on disk: the path the index
 * names it by, and the path it is read from.
 */
interface DiscoveredSource {
  /** Repository-relative and NFC, as every index node names its file. */
  readonly path: string;
  /**
   * The same file as its directories listed it, name by name. It differs from
   * `path` only for a decomposed (NFD) name, which a byte-exact file system,
   * such as Linux ext4, finds only by its own bytes.
   */
  readonly diskPath: string;
}

interface DiscoveredIndexSources {
  readonly repositoryRoot: string;
  /** The normalized include set, when the caller narrowed the index. */
  readonly includePaths: readonly string[] | undefined;
  readonly sources: readonly DiscoveredSource[];
  /** In-repository symlinks the untargeted walk admitted, alias to target. */
  readonly aliases: ReadonlyMap<string, string>;
  readonly limitations: readonly ContentIndexLimitation[];
}

/** What the untargeted walk learns about on-disk symlinks. */
interface UntargetedWalkState {
  readonly aliases: Map<string, string>;
  readonly limitations: ContentIndexLimitation[];
}

/** A directory the walk reads: its index path and its on-disk path, `""` for the root. */
interface WalkDirectory {
  readonly path: string;
  readonly diskPath: string;
}

async function discoverIndexSources(
  input: BuildContentIndexInput,
  scope: FocusedScopeState | undefined,
): Promise<DiscoveredIndexSources> {
  if (!GIT_OBJECT_ID.test(input.repositoryRevision)) {
    // hygiene: envelope - code-bearing ContentIndexError is rendered by the host boundary.
    throw new ContentIndexError(
      "invalid-revision",
      "Content index revision must be a full lowercase Git object ID.",
    );
  }
  const repositoryRoot = await realpath(resolve(input.repositoryPath));
  if (!(await stat(repositoryRoot)).isDirectory()) {
    // hygiene: envelope - code-bearing ContentIndexError is rendered by the host boundary.
    throw new ContentIndexError("unsafe-path", "Content index root must be a directory.");
  }
  const includePaths =
    input.includePaths === undefined
      ? undefined
      : [...new Set(input.includePaths.map((path) => requestedPathKey(path)))].sort(compareText);
  const walk: UntargetedWalkState | undefined = scope
    ? undefined
    : { aliases: new Map(), limitations: [] };
  const leftOut: ContentIndexLimitation[] = [];
  const found = await discoverSources(
    repositoryRoot,
    { path: "", diskPath: "" },
    includePaths,
    scope,
    walk,
    leftOut,
  );
  return {
    repositoryRoot,
    includePaths,
    sources: onePerIndexPath(found, leftOut),
    aliases: walk?.aliases ?? new Map(),
    limitations: [...(walk?.limitations ?? []), ...leftOut],
  };
}

async function compileDiscoveredIndexV1(
  input: BuildContentIndexInput,
  discovered: DiscoveredIndexSources,
  scope: FocusedScopeState | undefined,
): Promise<ContentIndexV1> {
  const { repositoryRoot } = discovered;
  const sources = await Promise.all(
    discovered.sources.map(async ({ path, diskPath }): Promise<SourceFile> => {
      // Read by the name on disk; the index names the file by `path`.
      const bytes = await readFile(resolve(repositoryRoot, ...diskPath.split("/")));
      return {
        path,
        contents: bytes.toString("utf8").replace(/\r\n?/gu, "\n"),
        contentSha256: sha256(bytes),
        byteLength: bytes.byteLength,
      };
    }),
  );
  // A focused index's selected paths are its targets; an untargeted index
  // names them in `targetPaths`. Only a target page stops on an anchor.
  const targetPaths = scope
    ? scope.includePaths
    : (input.targetPaths ?? []).map((path) => requestedPathKey(path).replace(/\/+$/u, ""));
  const anchorLimitations: ContentIndexLimitation[] = [];
  const documents = sources
    .filter((source) => MARKDOWN_EXTENSION.test(source.path))
    .map((source) =>
      parseDocument(
        source,
        false,
        isTargetPath(source.path, targetPaths)
          ? undefined
          : pageAnchorRecorder(source.path, anchorLimitations),
      ),
    )
    .sort((left, right) => compareText(left.sourcePath, right.sourcePath));
  assertUniqueDocuments(documents);
  const byPath = new Map(documents.map((document) => [document.sourcePath, document]));

  const nodes: ContentNode[] = [];
  const edges: StructuralEdge[] = [];
  for (const document of documents) {
    nodes.push(...sectionNodes(document));
    edges.push(...sectionEdges(document));
  }
  for (const document of documents) {
    edges.push(...(await resolveLinkEdgesV1(document, byPath, repositoryRoot)));
  }
  const navigationSources = sources.filter((source) => !MARKDOWN_EXTENSION.test(source.path));
  const navigationResult = navigation(navigationSources, byPath, {
    ...(scope ? { scope } : {}),
    aliases: discovered.aliases,
    ...(discovered.includePaths ? { includePaths: discovered.includePaths } : {}),
    hasDirectory: repositoryDirectoriesOnDisk(repositoryRoot, input.trackedAliasPaths ?? []),
  });
  for (const edge of navigationResult.edges) edges.push(edge);
  const normalizedEdges = uniqueEdges(edges);
  const contentDigest = sha256(
    sources.map((source) => `${source.contentSha256}  ${source.path}\n`).join(""),
  );

  for (const document of documents) {
    const graphShape = normalizedEdges.filter((edge) => edgeTouchesDocument(edge, document));
    const navigationShape = graphShape.filter((edge) => edge.kind === "navigation");
    const node: DocumentNode = {
      id: document.id,
      kind: "document",
      sourcePath: document.sourcePath,
      format: document.format,
      byteLength: document.byteLength,
      anchors: [...document.anchors],
      frontmatter: [...document.frontmatter],
      directives: [...document.directives],
      codeBlocks: [...document.codeBlocks],
      regions: {
        body: document.bodyDigest,
        headings: document.headingsDigest,
        metadata: document.metadataDigest,
        navigation: canonicalDigest(navigationShape),
        graph: canonicalDigest(graphShape.filter((edge) => edge.kind !== "navigation")),
      },
    };
    nodes.push(node);
  }
  nodes.sort((left, right) => compareText(left.id, right.id));

  const repository = { revision: input.repositoryRevision, contentDigest };
  const indexDigest = canonicalDigest({
    schemaVersion: 1,
    repository,
    nodes,
    edges: normalizedEdges,
  });
  const sectionCount = nodes.filter((node) => node.kind === "section").length;
  const limitations = [
    ...discovered.limitations,
    ...anchorLimitations,
    ...navigationResult.limitations,
  ];
  const index: ContentIndexV1 = {
    schemaVersion: 1,
    repository,
    indexDigest,
    nodes,
    edges: normalizedEdges,
    evidence: {
      repositoryRevision: input.repositoryRevision,
      contentDigest,
      indexDigest,
      documentCount: documents.length,
      sectionCount,
      edgeCount: normalizedEdges.length,
    },
  };
  return recordIndexLimitations(index, limitations);
}

function sortedCoverage(coverage: ScopedIndexCoverage): ScopedIndexCoverage {
  return {
    refusedAliasPaths: [...new Set(coverage.refusedAliasPaths)].sort(compareText),
    incompleteNavigationPaths: [...new Set(coverage.incompleteNavigationPaths)].sort(compareText),
    skippedOptionalAliasPaths: [...new Set(coverage.skippedOptionalAliasPaths)].sort(compareText),
    outOfScopeNavigationTargets: coverage.outOfScopeNavigationTargets,
    aliasNavigationTargets: coverage.aliasNavigationTargets,
  };
}

export async function buildContentIndexV2(
  input: BuildContentIndexV2Input,
): Promise<ContentIndexV2> {
  const trackedFiles = await listTrackedRepositoryFiles(input.workspace);
  if (!GIT_OBJECT_ID.test(input.workspace.revision)) {
    throw new ContentIndexError("invalid-revision", "Content index workspace revision is invalid.");
  }
  const trackedFileBytes = new Map(trackedFiles.map((file) => [file.path, file.byteLength]));
  const limits = resolveContentIndexLimits();
  const sourceFiles = trackedFiles.filter((file) => isIndexSourcePath(file.path));
  const sources = await readSourcesInPathOrder(sourceFiles, async (file): Promise<SourceFile> => {
    assertSourceWithinLimit(file, limits.maxSourceBytes);
    let bytes: Buffer;
    try {
      bytes = await readTrackedRepositoryFile(
        input.workspace,
        file.path,
        limits.maxSourceBytes.value,
      );
    } catch (error) {
      throw contentReadError(error, "source");
    }
    return {
      path: file.path,
      contents: strictUtf8(bytes, file.path),
      contentSha256: sha256(bytes),
      byteLength: bytes.byteLength,
    };
  });
  // Nothing here names targets, so every page records its anchor problems.
  const anchorLimitations: ContentIndexLimitation[] = [];
  const documents = sources
    .filter((source) => MARKDOWN_EXTENSION.test(source.path))
    .map((source) =>
      parseDocument(source, true, pageAnchorRecorder(source.path, anchorLimitations)),
    )
    .sort((left, right) => compareText(left.sourcePath, right.sourcePath));
  assertUniqueDocuments(documents);
  const byPath = new Map(documents.map((document) => [document.sourcePath, document]));
  const nodes: ContentNode[] = [];
  const edges: StructuralEdgeV2[] = [];
  for (const document of documents) {
    nodes.push(...sectionNodes(document));
    edges.push(...sectionEdges(document));
  }
  const assets = new Map<string, Promise<AssetSource>>();
  const budget: AssetBudget = { totalBytes: 0, limits, leftOut: new Set(), limitations: [] };
  for (const document of documents) {
    edges.push(
      ...(await resolveLinkEdgesV2(document, byPath, input, trackedFileBytes, assets, budget)),
    );
  }
  const navigationResult = navigation(
    sources.filter((source) => !MARKDOWN_EXTENSION.test(source.path)),
    byPath,
    { hasDirectory: await trackedDirectories(input.workspace, trackedFiles) },
  );
  for (const edge of navigationResult.edges) edges.push(edge);
  const normalizedEdges = uniqueEdgesV2(edges);
  const manifest = new Map(sources.map((source) => [source.path, source.contentSha256]));
  for (const [path, asset] of assets) manifest.set(path, (await asset).contentSha256);
  const contentDigest = sha256(
    [...manifest]
      .sort(([left], [right]) => compareText(left, right))
      .map(([path, digest]) => `${digest}  ${path}\n`)
      .join(""),
  );
  for (const document of documents) {
    const graphShape = normalizedEdges.filter((edge) => edgeTouchesDocumentV2(edge, document));
    const navigationShape = graphShape.filter((edge) => edge.kind === "navigation");
    nodes.push(documentNodeV2(document, navigationShape, graphShape));
  }
  nodes.sort((left, right) => compareText(left.id, right.id));
  const repository = { revision: input.workspace.revision, contentDigest };
  const indexDigest = canonicalDigest({
    schemaVersion: 2,
    repository,
    nodes,
    edges: normalizedEdges,
  });
  const sectionCount = nodes.filter((node) => node.kind === "section").length;
  const index: ContentIndexV2 = {
    schemaVersion: 2,
    repository,
    indexDigest,
    nodes,
    edges: normalizedEdges,
    evidence: {
      repositoryRevision: repository.revision,
      contentDigest,
      indexDigest,
      documentCount: documents.length,
      sectionCount,
      edgeCount: normalizedEdges.length,
      assetCount: assets.size,
    },
  };
  return recordIndexLimitations(index, [
    ...anchorLimitations,
    ...budget.limitations,
    ...navigationResult.limitations,
  ]);
}

/**
 * Builds the explicit RST-aware format version. V1 and V2 deliberately retain
 * their source selection, parser, and digest behavior.
 */
export async function buildContentIndexV3(
  input: BuildContentIndexV3Input,
): Promise<ContentIndexV3> {
  const trackedFiles = await listTrackedRepositoryFiles(input.workspace);
  if (!GIT_OBJECT_ID.test(input.workspace.revision)) {
    // hygiene: envelope - code-bearing ContentIndexError is rendered by the host boundary.
    throw new ContentIndexError("invalid-revision", "Content index workspace revision is invalid.");
  }
  const trackedFileBytes = new Map(trackedFiles.map((file) => [file.path, file.byteLength]));
  const limits = resolveContentIndexLimits();
  const sourceFiles = trackedFiles.filter((file) => isIndexSourcePathV3(file.path));
  const sources = await readSourcesInPathOrder(sourceFiles, async (file): Promise<SourceFile> => {
    assertSourceWithinLimit(file, limits.maxSourceBytes);
    let bytes: Buffer;
    try {
      bytes = await readTrackedRepositoryFile(
        input.workspace,
        file.path,
        limits.maxSourceBytes.value,
      );
    } catch (error) {
      throw contentReadError(error, "source");
    }
    return {
      path: file.path,
      contents: strictUtf8(bytes, file.path),
      contentSha256: sha256(bytes),
      byteLength: bytes.byteLength,
    };
  });
  const anchorLimitations: ContentIndexLimitation[] = [];
  const documents: ParsedDocumentV3[] = sources
    .filter((source) => isDocumentSourcePathV3(source.path))
    .map((source) => {
      if (RST_EXTENSION.test(source.path)) {
        return parseRstDocument({
          sourcePath: source.path,
          contents: source.contents,
          byteLength: source.byteLength,
        }) as ParsedDocumentV3;
      }
      const parsed = parseDocument(
        source,
        true,
        pageAnchorRecorder(source.path, anchorLimitations),
      );
      return enrichMystV3(parsed, source.contents);
    })
    .sort((left, right) => compareText(left.sourcePath, right.sourcePath));
  assertUniqueDocuments(documents);
  const byPath = new Map(documents.map((document) => [document.sourcePath, document]));
  const referenceTargets = new Map<string, (typeof documents)[number]>();
  for (const document of documents) {
    for (const anchor of document.anchors) {
      const prior = referenceTargets.get(anchor);
      if (prior && prior.id !== document.id) {
        // hygiene: envelope - code-bearing ContentIndexError is rendered by the host boundary.
        throw new ContentIndexError(
          "duplicate-node-identity",
          `Content index contains a duplicate reference label: ${anchor}.`,
        );
      }
      referenceTargets.set(anchor, document);
    }
  }
  const nodes: ContentNodeV3[] = [];
  const edges: StructuralEdgeV2[] = [];
  for (const document of documents) {
    nodes.push(...sectionNodes(document));
    edges.push(...sectionEdges(document));
  }
  const assets = new Map<string, Promise<AssetSource>>();
  const budget: AssetBudget = { totalBytes: 0, limits, leftOut: new Set(), limitations: [] };
  for (const document of documents) {
    edges.push(
      ...(await resolveLinkEdgesV3(
        document,
        byPath,
        referenceTargets,
        input,
        trackedFileBytes,
        assets,
        budget,
      )),
    );
  }
  const navigationResult = navigation(
    sources.filter((source) => !isDocumentSourcePathV3(source.path)),
    byPath,
    { hasDirectory: await trackedDirectories(input.workspace, trackedFiles) },
  );
  for (const edge of navigationResult.edges) edges.push(edge);
  const normalizedEdges = uniqueEdgesV2(edges);
  const manifest = new Map(sources.map((source) => [source.path, source.contentSha256]));
  for (const [path, asset] of assets) manifest.set(path, (await asset).contentSha256);
  const contentDigest = sha256(
    [...manifest]
      .sort(([left], [right]) => compareText(left, right))
      .map(([path, digest]) => `${digest}  ${path}\n`)
      .join(""),
  );
  for (const document of documents) {
    const graphShape = normalizedEdges.filter((edge) => edgeTouchesDocumentV2(edge, document));
    const navigationShape = graphShape.filter((edge) => edge.kind === "navigation");
    nodes.push(documentNodeV3(document, navigationShape, graphShape));
  }
  nodes.sort((left, right) => compareText(left.id, right.id));
  const repository = { revision: input.workspace.revision, contentDigest };
  const indexDigest = canonicalDigest({
    schemaVersion: 3,
    repository,
    nodes,
    edges: normalizedEdges,
  });
  const sectionCount = nodes.filter((node) => node.kind === "section").length;
  const index: ContentIndexV3 = {
    schemaVersion: 3,
    repository,
    indexDigest,
    nodes,
    edges: normalizedEdges,
    evidence: {
      repositoryRevision: repository.revision,
      contentDigest,
      indexDigest,
      documentCount: documents.length,
      sectionCount,
      edgeCount: normalizedEdges.length,
      assetCount: assets.size,
    },
  };
  return recordIndexLimitations(index, [
    ...anchorLimitations,
    ...budget.limitations,
    ...navigationResult.limitations,
  ]);
}

function documentNodeV2(
  document: ParsedDocument,
  navigationShape: StructuralEdgeV2[],
  graphShape: StructuralEdgeV2[],
): DocumentNode {
  return {
    id: document.id,
    kind: "document",
    sourcePath: document.sourcePath,
    format: document.format,
    byteLength: document.byteLength,
    anchors: [...document.anchors],
    frontmatter: [...document.frontmatter],
    directives: [...document.directives],
    codeBlocks: [...document.codeBlocks],
    regions: {
      body: document.bodyDigest,
      headings: document.headingsDigest,
      metadata: document.metadataDigest,
      navigation: canonicalDigest(navigationShape),
      graph: canonicalDigest(
        graphShape.filter((edge) => edge.kind !== "navigation").map(structuralGraphEdgeV2),
      ),
    },
  };
}

function documentNodeV3(
  document: ParsedDocumentV3,
  navigationShape: StructuralEdgeV2[],
  graphShape: StructuralEdgeV2[],
): DocumentNodeV3 {
  return {
    ...documentNodeV2(document as ParsedDocument, navigationShape, graphShape),
    format: document.format,
  };
}

/** One directory entry: the index name of an on-disk entry or of a tracked alias. */
interface ListedEntry {
  /** NFC; for a name that is not UTF-8, its lossy decoding. */
  readonly name: string;
  /** The name exactly as the directory lists it; absent for an alias the export left out. */
  readonly diskName: string | undefined;
  readonly entry: Dirent<Buffer> | undefined;
  /** Why the index cannot hold this name, when it cannot. */
  readonly unindexable: string | undefined;
}

/**
 * Walks one directory. Every name is matched, filtered, and recorded in NFC,
 * the form an index path takes, but each file is read and each directory
 * walked by the name its directory listed, byte for byte. A byte-exact file
 * system such as Linux ext4 finds a decomposed (NFD) name only that way.
 *
 * A source or directory whose name an index path cannot hold is left out and
 * named in `leftOut`, never renamed into a path that names another file: a
 * backslash is a character of the name, not a separator.
 */
async function discoverSources(
  root: string,
  directory: WalkDirectory,
  includePaths: readonly string[] | undefined,
  scope: FocusedScopeState | undefined,
  walk: UntargetedWalkState | undefined,
  leftOut: ContentIndexLimitation[],
): Promise<DiscoveredSource[]> {
  const entries = await readdir(resolve(root, ...directory.diskPath.split("/").filter(Boolean)), {
    withFileTypes: true,
    encoding: "buffer",
  });
  const listed: ListedEntry[] = entries.map((entry) => listedEntry(entry, directory.path === ""));
  const trackedAliases = scope?.trackedAliasesByDirectory.get(directory.path) ?? new Set<string>();
  for (const alias of trackedAliases) {
    if (!listed.some((item) => item.name === alias)) {
      listed.push({ name: alias, diskName: undefined, entry: undefined, unindexable: undefined });
    }
  }
  listed.sort(
    (left, right) =>
      compareText(left.name, right.name) || compareText(left.diskName ?? "", right.diskName ?? ""),
  );
  const sources: DiscoveredSource[] = [];
  for (const { name, diskName, entry, unindexable } of listed) {
    const path = directory.path ? `${directory.path}/${name}` : name;
    const diskPath =
      diskName === undefined
        ? path
        : directory.diskPath
          ? `${directory.diskPath}/${diskName}`
          : diskName;
    if (trackedAliases.has(name) || entry?.isSymbolicLink()) {
      // A focused index classifies the alias by relevance and never follows it.
      if (scope) recordFocusedAlias(path, name, scope);
      else await admitUntargetedSymlink(root, path, diskPath, includePaths, walk!);
      continue;
    }
    // Every name that is not a tracked alias came from the directory listing.
    if (entry!.isDirectory()) {
      if (
        !EXCLUDED_DIRECTORIES.has(name) &&
        !(directory.path === "" && EXCLUDED_ROOT_DIRECTORIES.has(name)) &&
        !isUnselectedInputCorpus(path, includePaths) &&
        shouldWalkDirectory(path, includePaths)
      ) {
        if (unindexable) {
          leftOut.push({ path, reason: "unindexable-name", detail: unindexable, directory: true });
          continue;
        }
        sources.push(
          ...(await discoverSources(root, { path, diskPath }, includePaths, scope, walk, leftOut)),
        );
      }
      continue;
    }
    if (
      (MARKDOWN_EXTENSION.test(path) ||
        NAVIGATION_NAMES.has(name) ||
        UNSUPPORTED_NAVIGATION_NAMES.has(name)) &&
      shouldIncludeSource(path, includePaths)
    ) {
      if (unindexable) leftOut.push({ path, reason: "unindexable-name", detail: unindexable });
      else sources.push({ path, diskPath });
    }
  }
  return sources.sort((left, right) => compareText(left.path, right.path));
}

/**
 * The index name of one listed entry, and why an index path cannot hold it.
 * The test is the content index decoder's path rule (`decoder.ts`): text with
 * no control character or backslash, plus the artifact rule that a path does
 * not begin like a Windows drive (`artifacts/validate.ts`), since the
 * preflight's ontology names every indexed page.
 */
function listedEntry(entry: Dirent<Buffer>, atRoot: boolean): ListedEntry {
  const bytes = entry.name;
  let diskName: string;
  try {
    diskName = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return {
      name: bytes.toString("utf8"),
      diskName: undefined,
      entry,
      unindexable: `its name is not UTF-8 text (bytes ${bytes.toString("hex")})`,
    };
  }
  const name = diskName.normalize("NFC");
  return {
    name,
    diskName,
    entry,
    unindexable: name.includes("\\")
      ? "its name holds a backslash, which a content index path cannot hold"
      : /[\u0000-\u001f\u007f]/u.test(name)
        ? "its name holds a control character, which a content index path cannot hold"
        : atRoot && /^[A-Za-z]:/u.test(name)
          ? "its name begins like a Windows drive, which a content index path cannot"
          : undefined,
  };
}

/**
 * Keeps one source for each index path. Two names a byte-exact file system
 * holds apart can share one once both are NFC, a composed and a decomposed
 * spelling of the same name. The index keeps the composed spelling, or else
 * the first in code-unit order, and names each other one in `leftOut`.
 */
function onePerIndexPath(
  sources: readonly DiscoveredSource[],
  leftOut: ContentIndexLimitation[],
): DiscoveredSource[] {
  const byPath = new Map<string, DiscoveredSource[]>();
  for (const source of sources) {
    byPath.set(source.path, [...(byPath.get(source.path) ?? []), source]);
  }
  const kept: DiscoveredSource[] = [];
  for (const [path, spellings] of byPath) {
    const [first, ...others] = [...spellings].sort(
      (left, right) =>
        Number(right.diskPath === path) - Number(left.diskPath === path) ||
        compareText(left.diskPath, right.diskPath),
    );
    kept.push(first!);
    for (const other of others) {
      leftOut.push({
        path: other.diskPath,
        reason: "normalized-name-collision",
        resolvedPath: first!.diskPath,
        detail: "its name is the same as the kept file's once both are Unicode-normalized (NFC)",
      });
    }
  }
  return kept.sort((left, right) => compareText(left.path, right.path));
}

/**
 * An on-disk symlink the untargeted walk meets is never read through. One the
 * selection needs, an include path or a directory on its path, is refused as
 * before. Any other is resolved: inside the repository it becomes an alias
 * that navigation resolves to its target; leading outside the repository, or
 * nowhere, it is skipped and recorded.
 */
async function admitUntargetedSymlink(
  root: string,
  path: string,
  diskPath: string,
  includePaths: readonly string[] | undefined,
  walk: UntargetedWalkState,
): Promise<void> {
  if (includePaths?.some((include) => include === path || include.startsWith(`${path}/`))) {
    // hygiene: envelope - code-bearing ContentIndexError is rendered by the host boundary.
    throw new ContentIndexError("unsafe-path", `Content index rejects symlink: ${path}.`);
  }
  let target: string | undefined;
  try {
    const fromRoot = relative(root, await realpath(resolve(root, ...diskPath.split("/"))));
    if (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot)) {
      // Navigation looks pages up by their index path.
      target = fromRoot.split(sep).join("/").normalize("NFC");
    }
  } catch {
    target = undefined;
  }
  if (target === undefined) {
    walk.limitations.push({ path, reason: "symlink-outside-repository" });
  } else {
    walk.aliases.set(path, target);
  }
}

/**
 * Classify one alias met while walking a directory a focused index needs.
 * Only called for walked directories, so every such directory is a target, a
 * descendant of a directory target, or an ancestor of a target.
 */
function recordFocusedAlias(path: string, name: string, scope: FocusedScopeState): void {
  // (a) The alias IS a target, or is a directory a target's path runs
  // through (a symlinked `docs/`).
  if (scope.includePaths.some((include) => include === path || include.startsWith(`${path}/`))) {
    scope.coverage.refusedAliasPaths.push(path);
    return;
  }
  // (a) Inside a directory target every entry is selected, except the
  // excluded directory names the walk never enters either.
  if (scope.includePaths.some((include) => path.startsWith(`${include}/`))) {
    if (!EXCLUDED_DIRECTORIES.has(name)) scope.coverage.refusedAliasPaths.push(path);
    return;
  }
  // (b) A navigation source on a target's ancestor chain is required context.
  if (NAVIGATION_NAMES.has(name) || UNSUPPORTED_NAVIGATION_NAMES.has(name)) {
    scope.coverage.incompleteNavigationPaths.push(path);
    return;
  }
  // (c) Any other page beside the chain is optional: skip, stay visible.
  if (MARKDOWN_EXTENSION.test(name)) {
    scope.coverage.skippedOptionalAliasPaths.push(path);
  }
  // Anything else (`.envrc`, a symlinked sibling directory) is not a
  // documentation source for these targets and is never read.
}

function shouldWalkDirectory(dirPath: string, includePaths?: readonly string[]): boolean {
  if (includePaths === undefined) return true;
  return includePaths.some(
    (include) =>
      include === dirPath || include.startsWith(`${dirPath}/`) || dirPath.startsWith(`${include}/`),
  );
}

function isUnselectedInputCorpus(path: string, includePaths?: readonly string[]): boolean {
  if (!isInputCorpusPath(path)) return false;
  if (includePaths === undefined) return true;
  return !includePaths.some(
    (include) =>
      include === path || include.startsWith(`${path}/`) || path.startsWith(`${include}/`),
  );
}

function isInputCorpusPath(path: string): boolean {
  const parts = path.split("/");
  if (parts.includes("docs")) return false;
  if (path === "packages/quality" || path.startsWith("packages/quality/")) return true;
  return parts.some((part) => EXCLUDED_INPUT_CORPUS_SEGMENTS.has(part));
}

function shouldIncludeSource(filePath: string, includePaths?: readonly string[]): boolean {
  if (includePaths === undefined) return true;
  const directory = parentPosix(filePath);
  return includePaths.some((include) => {
    if (filePath === include || filePath.startsWith(`${include}/`)) return true;
    return ancestorDirectories(include).includes(directory);
  });
}

function parentPosix(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

function ancestorDirectories(path: string): string[] {
  const directories = [""];
  const parts = path.split("/");
  let prefix = "";
  for (let index = 0; index < parts.length - 1; index += 1) {
    prefix = prefix ? `${prefix}/${parts[index]}` : parts[index]!;
    directories.push(prefix);
  }
  return directories;
}

function isIndexSourcePath(path: string): boolean {
  const parts = path.split("/");
  if (
    parts.some((part) => EXCLUDED_DIRECTORIES.has(part)) ||
    (parts.length > 1 && EXCLUDED_ROOT_DIRECTORIES.has(parts[0]!)) ||
    isInputCorpusPath(path)
  ) {
    return false;
  }
  const name = parts.at(-1)!;
  return (
    MARKDOWN_EXTENSION.test(path) ||
    NAVIGATION_NAMES.has(name) ||
    UNSUPPORTED_NAVIGATION_NAMES.has(name)
  );
}

/**
 * Whether a whole-repository content index reads `path` as a source. A hosted
 * live-agent turn points its context packet at a page only when this holds,
 * because a context target the index cannot find fails the step (#2400).
 */
export function isContentIndexSourcePath(path: string): boolean {
  return isIndexSourcePathV3(path);
}

function isIndexSourcePathV3(path: string): boolean {
  if (!isIndexSourcePath(path)) {
    const parts = path.split("/");
    if (
      !RST_EXTENSION.test(path) ||
      parts.some((part) => EXCLUDED_DIRECTORIES.has(part)) ||
      (parts.length > 1 && EXCLUDED_ROOT_DIRECTORIES.has(parts[0]!)) ||
      isInputCorpusPath(path)
    ) {
      return false;
    }
  }
  return true;
}

function isDocumentSourcePathV3(path: string): boolean {
  return MARKDOWN_EXTENSION.test(path) || RST_EXTENSION.test(path);
}

/**
 * Decode a page's bytes as strict UTF-8 without NUL bytes, or refuse with
 * `invalid-document-encoding`, naming the page (escaped) and the reason so an
 * operator can fix that file (#1932).
 */
function strictUtf8(bytes: Uint8Array, path: string): string {
  const nul = bytes.indexOf(0);
  if (nul >= 0) throw invalidDocumentEncoding(path, `it holds a NUL byte at byte offset ${nul}`);
  let contents: string;
  try {
    contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw invalidDocumentEncoding(path, "it is not valid UTF-8");
  }
  return contents.replace(/\r\n?/gu, "\n");
}

/**
 * Read every source, then refuse with the failure of the first source in path
 * order. `Promise.all` would refuse with whichever read failed first in
 * completion order, so a tree with several unreadable pages would name a
 * different page from one build to the next, and the repository inventory
 * binds the page it names into its digest (#1932).
 */
async function readSourcesInPathOrder<File extends { readonly path: string }, Source>(
  files: readonly File[],
  read: (file: File) => Promise<Source>,
): Promise<Source[]> {
  const settled = await Promise.allSettled(files.map((file) => read(file)));
  let first: { readonly path: string; readonly reason: unknown } | undefined;
  for (const [index, result] of settled.entries()) {
    if (result.status !== "rejected") continue;
    const path = files[index]!.path;
    if (!first || compareText(path, first.path) < 0) first = { path, reason: result.reason };
  }
  if (first) throw first.reason;
  return settled.map((result) => (result as PromiseFulfilledResult<Source>).value);
}

function invalidDocumentEncoding(path: string, reason: string): ContentIndexError {
  return new ContentIndexError(
    "invalid-document-encoding",
    `Content index document source ${displayNavigationText(path)} is not strict UTF-8 text: ${reason}.`,
    { sourcePath: path },
  );
}

function contentReadError(error: unknown, kind: "source" | "asset"): ContentIndexError {
  if (error instanceof RepositoryWorkspaceReadError) {
    if (error.code === "oversize") {
      return new ContentIndexError(
        kind === "source" ? "source-too-large" : "asset-too-large",
        `Content index ${kind} byte limit exceeded.`,
      );
    }
    if (error.code === "changed") {
      return new ContentIndexError("tracked-file-changed", "Tracked file changed during indexing.");
    }
    if (error.code === "unsafe-kind") {
      return new ContentIndexError("unsafe-path", "Tracked target has an unsafe file kind.");
    }
    if (error.code === "read-failed") {
      return new ContentIndexError("tracked-file-unreadable", "Tracked file could not be read.");
    }
  }
  return new ContentIndexError("tracked-file-unreadable", "Tracked file could not be read.");
}

/**
 * With `recordAnchorProblem`, an anchor the page cannot admit is recorded and
 * left out: a heading without its anchor is no section, the section before it
 * runs on to the next kept heading, and its lines count as body text. Without
 * it, the problem stops the index with its code.
 */
function parseDocument(
  source: SourceFile,
  strictTargets: boolean,
  recordAnchorProblem?: PageAnchorRecorder,
): ParsedDocument {
  const lines = source.contents.split("\n");
  const {
    end: frontmatterEnd,
    fields,
    explicitId,
    digest: metadataDigest,
  } = parseFrontmatter(lines);
  const headingLines = new Map<
    number,
    { depth: number; text: string; explicit?: string; underline?: number }
  >();
  const labels = new Map<number, string>();
  const directives: DirectiveShape[] = [];
  const codeBlocks: CodeBlockShape[] = [];
  const links: ParsedLink[] = [];
  const referenceDefinitions = new Map<string, string>();
  const referenceUses: ReferenceLinkUse[] = [];
  const htmlAnchors: Array<{ anchor: string; line: number }> = [];
  let fence: { marker: string; startLine: number; language?: string } | undefined;
  let hasGfm = false;
  let hasMyst = false;
  let paragraphText = false;

  for (let index = frontmatterEnd; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    // A `---` or `===` line underlines a setext heading only when the line
    // above it is paragraph text; after anything else it is not a heading.
    const followsParagraphText = paragraphText;
    paragraphText = false;
    if (fence) {
      if (
        new RegExp(
          `^\\s*${escapeRegExp(fence.marker[0]!)}{${fence.marker.length},}\\s*$`,
          "u",
        ).test(line)
      ) {
        codeBlocks.push({
          ...(fence.language ? { language: fence.language } : {}),
          startLine: fence.startLine,
          endLine: index + 1,
        });
        fence = undefined;
      }
      continue;
    }
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})\s*([^\s`]*)/u);
    if (fenceMatch) {
      fence = {
        marker: fenceMatch[1]!,
        startLine: index + 1,
        ...(fenceMatch[2] ? { language: fenceMatch[2] } : {}),
      };
      continue;
    }
    const maskedLine = maskInlineCode(line);
    const label = maskedLine.match(/^\s*\(([^)]+)\)=\s*$/u);
    if (label) {
      labels.set(index + 1, normalizeAnchor(label[1]!));
      hasMyst = true;
      continue;
    }
    const directive = maskedLine.match(/^\s*:{3,}\s*\{?([A-Za-z][\w-]*)\}?/u);
    if (directive) {
      directives.push({ name: directive[1]!.toLowerCase(), line: index + 1 });
      hasMyst = true;
    }
    const atx = line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/u);
    if (atx) {
      const explicit = atx[2]!.match(/\s+\{#([^}]+)\}\s*$/u);
      headingLines.set(index + 1, {
        depth: atx[1]!.length,
        text: explicit ? atx[2]!.slice(0, explicit.index).trim() : atx[2]!,
        ...(explicit ? { explicit: explicit[1] } : {}),
      });
    } else if (followsParagraphText && SETEXT_UNDERLINE.test(line)) {
      headingLines.set(index, {
        depth: line.trim().startsWith("=") ? 1 : 2,
        text: (lines[index - 1] ?? "").trim(),
        underline: index + 1,
      });
    } else {
      paragraphText = isParagraphText(line, followsParagraphText);
    }
    if (/^\s*(?:[-*+]\s+\[[ xX]\]|\|.*\|\s*$)|~~.+~~/u.test(line)) hasGfm = true;
    for (const anchor of maskedLine.matchAll(/<a\s+[^>]*id=["']([^"']+)["'][^>]*>/giu)) {
      htmlAnchors.push({ anchor: normalizeAnchor(anchor[1]!), line: index + 1 });
    }
    const definition = maskedLine.match(/^ {0,3}\[([^\]]+)\]:\s*(?:<([^>]+)>|(\S+))(?:\s+.*)?$/u);
    if (definition) {
      const reference = normalizeReferenceLabel(definition[1]!);
      if (!referenceDefinitions.has(reference)) {
        referenceDefinitions.set(
          reference,
          unescapeMarkdownDestination(definition[2] ?? definition[3]!),
        );
      }
      paragraphText = false;
      continue;
    }
    for (const link of maskedLine.matchAll(
      /(!?)\[[^\]]*\]\(<((?:\\.|[^<>\\])*)>(?:\s+["'][^"']*["'])?\)/gu,
    )) {
      links.push({
        line: index + 1,
        target: unescapeMarkdownDestination(link[2]!),
        intent: link[1] ? "image" : "link",
      });
    }
    for (const link of maskedLine.matchAll(
      /(!?)\[[^\]]*\]\((?!<)([^)\s]+)(?:\s+["'][^"']*["'])?\)/gu,
    )) {
      links.push({
        line: index + 1,
        target: unescapeMarkdownDestination(link[2]!),
        intent: link[1] ? "image" : "link",
      });
    }
    for (const link of maskedLine.matchAll(/(!?)\[([^\]]+)\]\[([^\]]*)\]/gu)) {
      referenceUses.push({
        line: index + 1,
        label: normalizeReferenceLabel(link[3] || link[2]!),
        intent: link[1] ? "image" : "link",
      });
    }
    for (const link of maskedLine.matchAll(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>/giu)) {
      links.push({ line: index + 1, target: link[1]!, intent: "link" });
    }
    for (const image of maskedLine.matchAll(/<img\s+[^>]*src=["']([^"']+)["'][^>]*>/giu)) {
      links.push({ line: index + 1, target: image[1]!, intent: "image" });
    }
    if (
      strictTargets &&
      /<img\b[^>]*\bsrc\s*=/iu.test(maskedLine) &&
      !/<img\s+[^>]*src=["'][^"']+["'][^>]*>/iu.test(maskedLine)
    ) {
      throw new ContentIndexError(
        "unsupported-internal-target",
        `Unsupported HTML image target in ${source.path} at line ${index + 1}.`,
      );
    }
  }
  if (fence) {
    codeBlocks.push({
      ...(fence.language ? { language: fence.language } : {}),
      startLine: fence.startLine,
      endLine: lines.length,
    });
  }

  const documentIdentity = explicitId ? `explicit:${explicitId}` : `path:${source.path}`;
  const documentId = `document:${sha256(documentIdentity.normalize("NFC"))}`;
  const anchors = new Map<string, number>();
  const consumedLabels = new Set<number>();
  // Lines of an anchor the page leaves out: they stay body text.
  const leftOutLines = new Set<number>();
  const refuse = (problem: PageAnchorProblem): void => {
    if (!recordAnchorProblem) {
      // hygiene: envelope - code-bearing ContentIndexError is rendered by the host boundary.
      throw new ContentIndexError(problem.code, problem.message);
    }
    recordAnchorProblem(problem);
  };
  const kept: Array<{ line: number; depth: number; text: string; anchor: string }> = [];
  const orderedHeadings = [...headingLines.entries()].sort(([left], [right]) => left - right);
  for (const [line, heading] of orderedHeadings) {
    // An empty MyST label labels nothing: the heading keeps its own anchor,
    // and the label is reported on its own line below.
    const precedingLabel = labels.get(line - 1) || undefined;
    if (precedingLabel) consumedLabels.add(line - 1);
    const requestedAnchor = normalizeAnchor(precedingLabel ?? heading.explicit ?? heading.text);
    const anchor = precedingLabel
      ? addExplicitAnchor(anchors, requestedAnchor, source.path, line - 1, "MyST label")
      : heading.explicit
        ? addExplicitAnchor(anchors, requestedAnchor, source.path, line, "explicit anchor")
        : addGeneratedAnchor(anchors, requestedAnchor, source.path, line, heading.underline);
    if (typeof anchor !== "string") {
      refuse(anchor);
      leftOutLines.add(line);
      if (heading.underline !== undefined) leftOutLines.add(heading.underline);
      if (precedingLabel) leftOutLines.add(line - 1);
      continue;
    }
    kept.push({ line, depth: heading.depth, text: heading.text, anchor });
  }
  // Each section runs to the next heading the page kept.
  const headings: Heading[] = kept.map(({ line, depth, text, anchor }, offset) => ({
    anchor,
    depth,
    line,
    endLine: (kept[offset + 1]?.line ?? lines.length + 1) - 1,
    id: `section:${sha256(`${documentId}\0${anchor}`)}`,
    textDigest: sha256(normalizeHeadingText(text)),
  }));
  for (const [line, anchor] of [...labels.entries()].sort(([left], [right]) => left - right)) {
    if (consumedLabels.has(line)) continue;
    const added = addExplicitAnchor(anchors, anchor, source.path, line, "MyST label");
    if (typeof added !== "string") {
      refuse(added);
      leftOutLines.add(line);
    }
  }
  const headingAnchors = new Set(headings.map((heading) => heading.anchor));
  for (const anchor of htmlAnchors) {
    // GFM permalink markup that repeats the heading slug is the same identity.
    if (headingAnchors.has(anchor.anchor)) continue;
    const added = addExplicitAnchor(anchors, anchor.anchor, source.path, anchor.line, "HTML id");
    if (typeof added !== "string") refuse(added);
  }
  for (const use of referenceUses) {
    const target = referenceDefinitions.get(use.label);
    if (target) links.push({ line: use.line, target, intent: use.intent });
  }

  const excludedBodyLines = new Set<number>();
  for (let line = 1; line <= frontmatterEnd; line += 1) excludedBodyLines.add(line);
  for (const [line, heading] of headingLines) {
    if (leftOutLines.has(line)) continue;
    excludedBodyLines.add(line);
    if (heading.underline !== undefined) excludedBodyLines.add(heading.underline);
  }
  for (const line of labels.keys()) {
    if (!leftOutLines.has(line)) excludedBodyLines.add(line);
  }
  const normalizedBody = lines
    .map((line, index) => (excludedBodyLines.has(index + 1) ? "" : normalizeBodyLine(line)))
    .join("\n");
  const format: ContentFormat =
    extname(source.path).toLowerCase() === ".mdx"
      ? "mdx"
      : hasMyst
        ? "myst"
        : hasGfm
          ? "gfm"
          : "markdown";
  return {
    sourcePath: source.path,
    id: documentId,
    format,
    byteLength: source.byteLength,
    anchors: [...anchors.keys()].sort(compareText),
    frontmatter: fields,
    directives: directives.sort((left, right) => left.line - right.line),
    codeBlocks,
    headings,
    links,
    bodyDigest: sha256(normalizedBody),
    headingsDigest: canonicalDigest({
      headings: headings.map(({ anchor, depth, textDigest }) => ({
        anchor,
        depth,
        textDigest,
      })),
      anchors: [...anchors.keys()].sort(compareText),
    }),
    metadataDigest,
  };
}

function parseFrontmatter(lines: string[]): {
  end: number;
  fields: FrontmatterFieldShape[];
  explicitId?: string;
  digest: string;
} {
  if ((lines[0] ?? "").trim() !== "---") {
    return { end: 0, fields: [], digest: canonicalDigest([]) };
  }
  const closing = lines.slice(1).findIndex((line) => line.trim() === "---");
  if (closing < 0) return { end: 0, fields: [], digest: canonicalDigest([]) };
  const end = closing + 2;
  const raw = lines.slice(1, end - 1);
  const fields: FrontmatterFieldShape[] = [];
  let explicitId: string | undefined;
  for (const line of raw) {
    const field = line.match(/^([A-Za-z_][\w.-]*):\s*(.*)$/u);
    if (!field) continue;
    const name = field[1]!;
    const value = field[2]!.trim();
    fields.push({ name, type: yamlShape(value) });
    if (name === "id" && value) explicitId = unquote(value).normalize("NFC");
  }
  fields.sort((left, right) => compareText(left.name, right.name));
  return {
    end,
    fields,
    ...(explicitId ? { explicitId } : {}),
    digest: sha256(raw.map((line) => line.trimEnd()).join("\n")),
  };
}

function yamlShape(value: string): FrontmatterFieldShape["type"] {
  if (!value || value === "{}") return value === "{}" ? "mapping" : "null";
  if (value === "[]" || value.startsWith("[")) return "sequence";
  if (value.startsWith("{")) return "mapping";
  if (/^(?:true|false)$/iu.test(value)) return "boolean";
  if (/^-?(?:\d+\.?\d*|\.\d+)$/u.test(value)) return "number";
  if (/^(?:null|~)$/iu.test(value)) return "null";
  return "string";
}

function sectionNodes(
  document: Pick<ParsedDocumentV3, "headings" | "id" | "sourcePath">,
): SectionNode[] {
  return document.headings.map((heading) => ({
    id: heading.id,
    kind: "section",
    documentId: document.id,
    sourcePath: document.sourcePath,
    anchor: heading.anchor,
    depth: heading.depth,
    startLine: heading.line,
    endLine: heading.endLine,
  }));
}

function sectionEdges(document: Pick<ParsedDocumentV3, "headings" | "id">): StructuralEdge[] {
  const edges: StructuralEdge[] = [];
  const stack: Heading[] = [];
  const siblings = new Map<string, Heading[]>();
  for (const heading of document.headings) {
    while (stack.length > 0 && stack[stack.length - 1]!.depth >= heading.depth) stack.pop();
    const parent = stack[stack.length - 1];
    const parentId = parent?.id ?? document.id;
    edges.push({ kind: "parent", from: heading.id, to: parentId });
    edges.push({ kind: "child", from: parentId, to: heading.id });
    const group = siblings.get(parentId) ?? [];
    const previous = group[group.length - 1];
    if (previous) {
      edges.push({ kind: "previous-sibling", from: heading.id, to: previous.id });
      edges.push({ kind: "next-sibling", from: previous.id, to: heading.id });
    }
    group.push(heading);
    siblings.set(parentId, group);
    stack.push(heading);
  }
  return edges;
}

async function resolveLinkEdgesV1(
  document: ParsedDocument,
  byPath: Map<string, ParsedDocument>,
  repositoryRoot: string,
): Promise<StructuralEdge[]> {
  const edges: StructuralEdge[] = [];
  for (const link of document.links) {
    if (link.intent === "image") continue;
    const from =
      [...document.headings].reverse().find((heading) => heading.line <= link.line)?.id ??
      document.id;
    if (isExternalTarget(link.target)) {
      edges.push({ kind: "outbound-link", from, to: `external:${sha256(link.target)}` });
      continue;
    }
    const [rawPath = "", rawFragment] = link.target.split("#", 2);
    let targetDocument: ParsedDocument | undefined;
    try {
      targetDocument = rawPath
        ? resolveDocumentPathV1(document.sourcePath, rawPath, byPath)
        : document;
    } catch (error) {
      if (!(error instanceof ContentIndexError) || error.code !== "unsafe-path") throw error;
      edges.push({ kind: "outbound-link", from, to: unresolvedTargetId(document, link) });
      continue;
    }
    if (!targetDocument) {
      let opaqueTarget: string | undefined;
      try {
        opaqueTarget = await existingOpaqueTargetV1(repositoryRoot, document.sourcePath, rawPath);
      } catch (error) {
        if (!(error instanceof ContentIndexError) || error.code !== "unsafe-path") throw error;
      }
      if (opaqueTarget) {
        edges.push({
          kind: "outbound-link",
          from,
          to: `external:${sha256(`opaque-internal\0${opaqueTarget}`)}`,
        });
        continue;
      }
      edges.push({ kind: "outbound-link", from, to: unresolvedTargetId(document, link) });
      continue;
    }
    let targetId = targetDocument.id;
    if (rawFragment) {
      const fragment = normalizeAnchor(safeDecodeV1(rawFragment));
      const section = targetDocument.headings.find((heading) => heading.anchor === fragment);
      if (!section && !targetDocument.anchors.includes(fragment)) {
        edges.push({ kind: "outbound-link", from, to: unresolvedTargetId(document, link) });
        continue;
      }
      targetId = section?.id ?? targetDocument.id;
    }
    edges.push({ kind: "outbound-link", from, to: targetId });
    edges.push({ kind: "backlink", from: targetId, to: from });
  }
  return edges;
}

function unresolvedTargetId(document: ParsedDocument, link: ParsedLink): string {
  return `external:${sha256(`unresolved-internal\0${document.sourcePath}\0${link.line}\0${link.target}`)}`;
}

async function resolveLinkEdgesV2(
  document: ParsedDocument,
  byPath: Map<string, ParsedDocument>,
  input: BuildContentIndexV2Input,
  trackedFileBytes: ReadonlyMap<string, number>,
  assetCache: Map<string, Promise<AssetSource>>,
  budget: AssetBudget,
): Promise<StructuralEdgeV2[]> {
  const edges: StructuralEdgeV2[] = [];
  for (const link of document.links) {
    const from =
      [...document.headings].reverse().find((heading) => heading.line <= link.line)?.id ??
      document.id;
    if (isExternalTarget(link.target)) {
      if (link.intent === "image") continue;
      edges.push({ kind: "outbound-link", from, to: `external:${sha256(link.target)}` });
      continue;
    }
    const { decodedPath, decodedFragment } = parseInternalTarget(link.target, document, link.line);
    const targetDocument = decodedPath
      ? resolveDocumentPath(document.sourcePath, decodedPath, byPath)
      : document;
    if (targetDocument && link.intent === "image") {
      throw new ContentIndexError(
        "unsupported-internal-target",
        `Image target is not a tracked non-document asset in ${document.sourcePath} at line ${link.line}.`,
      );
    }
    if (!targetDocument) {
      const asset = await resolveAssetSourceV2(
        input,
        trackedFileBytes,
        assetCache,
        budget,
        document.sourcePath,
        decodedPath,
      );
      // An asset past a content index limit is named as a limitation instead.
      if (asset === "left-out") continue;
      if (asset) {
        edges.push({
          kind: "asset-link",
          from,
          to: `asset:${canonicalDigest(asset.path)}`,
          target: {
            kind: "asset",
            sourcePath: asset.path,
            repositoryRevision: input.workspace.revision,
            digest: asset.contentSha256,
          },
        });
        continue;
      }
      throw new ContentIndexError(
        "broken-internal-target",
        `Broken internal target from ${document.sourcePath} at line ${link.line}.`,
      );
    }
    let targetId = targetDocument.id;
    if (decodedFragment) {
      const fragment = normalizeAnchor(decodedFragment);
      const section = targetDocument.headings.find((heading) => heading.anchor === fragment);
      if (!section && !targetDocument.anchors.includes(fragment)) {
        throw new ContentIndexError(
          "broken-internal-target",
          `Broken internal anchor from ${document.sourcePath} at line ${link.line}.`,
        );
      }
      targetId = section?.id ?? targetDocument.id;
    }
    edges.push({ kind: "outbound-link", from, to: targetId });
    edges.push({ kind: "backlink", from: targetId, to: from });
  }
  return edges;
}

async function resolveLinkEdgesV3(
  document: ParsedDocumentV3,
  byPath: Map<string, ParsedDocumentV3>,
  referenceTargets: ReadonlyMap<string, ParsedDocumentV3>,
  input: BuildContentIndexV3Input,
  trackedFileBytes: ReadonlyMap<string, number>,
  assetCache: Map<string, Promise<AssetSource>>,
  budget: AssetBudget,
): Promise<StructuralEdgeV2[]> {
  const edges: StructuralEdgeV2[] = [];
  for (const link of document.links) {
    const from =
      [...document.headings].reverse().find((heading) => heading.line <= link.line)?.id ??
      document.id;
    if (link.role === "ref") {
      const targetDocument = referenceTargets.get(normalizeAnchor(link.target));
      if (!targetDocument) {
        // hygiene: envelope - code-bearing ContentIndexError is rendered by the host boundary.
        throw new ContentIndexError(
          "broken-internal-target",
          `Broken local RST reference from ${document.sourcePath} at line ${link.line}.`,
        );
      }
      const section = targetDocument.headings.find(
        (heading) => heading.anchor === normalizeAnchor(link.target),
      );
      const target = section?.id ?? targetDocument.id;
      edges.push({ kind: "outbound-link", from, to: target });
      edges.push({ kind: "backlink", from: target, to: from });
      continue;
    }
    if (link.role === "doc") {
      const targetDocument = resolveDocumentPathV3(document.sourcePath, link.target, byPath);
      if (!targetDocument) {
        // hygiene: envelope - code-bearing ContentIndexError is rendered by the host boundary.
        throw new ContentIndexError(
          "broken-internal-target",
          `Broken local RST document reference from ${document.sourcePath} at line ${link.line}.`,
        );
      }
      edges.push({ kind: "outbound-link", from, to: targetDocument.id });
      edges.push({ kind: "backlink", from: targetDocument.id, to: from });
      continue;
    }
    if (isExternalTarget(link.target)) {
      if (link.intent === "image") continue;
      edges.push({ kind: "outbound-link", from, to: `external:${sha256(link.target)}` });
      continue;
    }
    const { decodedPath, decodedFragment } = parseInternalTarget(link.target, document, link.line);
    const targetDocument = decodedPath
      ? resolveDocumentPathV3(document.sourcePath, decodedPath, byPath)
      : document;
    if (targetDocument && link.intent === "image") {
      // hygiene: envelope - code-bearing ContentIndexError is rendered by the host boundary.
      throw new ContentIndexError(
        "unsupported-internal-target",
        `Image target is not a tracked non-document asset in ${document.sourcePath} at line ${link.line}.`,
      );
    }
    if (!targetDocument) {
      const asset = await resolveAssetSourceV2(
        input,
        trackedFileBytes,
        assetCache,
        budget,
        document.sourcePath,
        decodedPath,
      );
      // An asset past a content index limit is named as a limitation instead.
      if (asset === "left-out") continue;
      if (asset) {
        edges.push({
          kind: "asset-link",
          from,
          to: `asset:${canonicalDigest(asset.path)}`,
          target: {
            kind: "asset",
            sourcePath: asset.path,
            repositoryRevision: input.workspace.revision,
            digest: asset.contentSha256,
          },
        });
        continue;
      }
      // hygiene: envelope - code-bearing ContentIndexError is rendered by the host boundary.
      throw new ContentIndexError(
        "broken-internal-target",
        `Broken internal target from ${document.sourcePath} at line ${link.line}.`,
      );
    }
    let target = targetDocument.id;
    if (decodedFragment) {
      const fragment = normalizeAnchor(decodedFragment);
      const section = targetDocument.headings.find((heading) => heading.anchor === fragment);
      if (!section && !targetDocument.anchors.includes(fragment)) {
        // hygiene: envelope - code-bearing ContentIndexError is rendered by the host boundary.
        throw new ContentIndexError(
          "broken-internal-target",
          `Broken internal anchor from ${document.sourcePath} at line ${link.line}.`,
        );
      }
      target = section?.id ?? targetDocument.id;
    }
    edges.push({ kind: "outbound-link", from, to: target });
    edges.push({ kind: "backlink", from: target, to: from });
  }
  return edges;
}

async function resolveAssetSourceV2(
  input: BuildContentIndexV2Input,
  trackedFileBytes: ReadonlyMap<string, number>,
  assetCache: Map<string, Promise<AssetSource>>,
  budget: AssetBudget,
  sourcePath: string,
  decodedTarget: string,
): Promise<AssetSource | "left-out" | undefined> {
  if (!decodedTarget) return undefined;
  if (
    !decodedTarget ||
    MARKDOWN_EXTENSION.test(decodedTarget) ||
    isAbsolute(decodedTarget) ||
    decodedTarget.startsWith("/")
  ) {
    return undefined;
  }
  const normalized = normalizeRelativePath(posix.join(posix.dirname(sourcePath), decodedTarget));
  const cached = assetCache.get(normalized);
  if (cached) return cached;
  if (budget.leftOut.has(normalized)) return "left-out";
  const byteLength = trackedFileBytes.get(normalized);
  if (byteLength === undefined) {
    const kind = await trackedRepositoryEntryKind(input.workspace, normalized);
    if (kind === "symlink") {
      throw new ContentIndexError("unsafe-path", "Content index asset target is a symlink.");
    }
    if (kind === "submodule") {
      throw new ContentIndexError(
        "unsupported-internal-target",
        "Content index asset target is a submodule.",
      );
    }
    return undefined;
  }
  const { limits } = budget;
  const exceeded:
    | { reason: AssetLimitationReason; limit: ResolvedLimit; observed: number }
    | undefined =
    assetCache.size >= limits.maxAssets.value
      ? { reason: "asset-count-exceeded", limit: limits.maxAssets, observed: assetCache.size + 1 }
      : byteLength > limits.maxAssetBytes.value
        ? { reason: "asset-too-large", limit: limits.maxAssetBytes, observed: byteLength }
        : budget.totalBytes + byteLength > limits.maxTotalAssetBytes.value
          ? {
              reason: "asset-bytes-exceeded",
              limit: limits.maxTotalAssetBytes,
              observed: budget.totalBytes + byteLength,
            }
          : undefined;
  if (exceeded) {
    // Left out, never a stop: the index names the asset and the limit.
    budget.leftOut.add(normalized);
    budget.limitations.push({
      path: normalized,
      reason: exceeded.reason,
      linkedFrom: sourcePath,
      detail: formatLimitObservation(exceeded.limit, exceeded.observed),
    });
    return "left-out";
  }
  budget.totalBytes += byteLength;
  const loaded = (async (): Promise<AssetSource> => {
    let bytes: Buffer;
    try {
      bytes = await readTrackedRepositoryFile(
        input.workspace,
        normalized,
        limits.maxAssetBytes.value,
      );
    } catch (error) {
      throw contentReadError(error, "asset");
    }
    if (bytes.byteLength !== byteLength) {
      throw new ContentIndexError("tracked-file-changed", "Tracked asset changed during indexing.");
    }
    return { path: normalized, contentSha256: sha256(bytes) };
  })();
  assetCache.set(normalized, loaded);
  return loaded;
}

/**
 * Something the index recorded instead of stopping: a navigation entry it
 * could not link, a navigation source it could not read or will not run, an
 * on-disk symlink that leaves the repository, an anchor that a page the
 * caller does not target cannot admit, or a file whose on-disk name the
 * index cannot hold.
 */
export interface ContentIndexLimitation {
  /** Repository-relative path of the navigation source, the symlink, or the page. */
  readonly path: string;
  readonly reason:
    | "page-not-indexed"
    | "outside-repository"
    | "unreadable-navigation"
    | "unsupported-navigation"
    | "symlink-outside-repository"
    | PageAnchorRefusalCode
    | AssetLimitationReason
    | NameLimitationReason;
  /** The entry as the navigation source spells it. */
  readonly entry?: string;
  /**
   * The repository path the entry resolves to; for a name collision, the
   * on-disk path of the file the index kept.
   */
  readonly resolvedPath?: string;
  /** The line of the page anchor the index left out. */
  readonly line?: number;
  /** For a left-out asset, the page whose link reached it. */
  readonly linkedFrom?: string;
  /** Set when an `unindexable-name` is a directory, so every page under it is left out. */
  readonly directory?: true;
  /**
   * Why the navigation source could not be read; for a page anchor, the
   * message the same anchor stops with on a target page; for a left-out name,
   * what about it the index cannot hold.
   */
  readonly detail?: string;
}

/**
 * Why the walk left a file, or a directory, out under its on-disk name: an
 * index path cannot hold the name, or the name is the same as another once
 * Unicode-normalized. The reason type and the run-warning filter read this
 * one list.
 */
const NAME_LIMITATION_REASON_LIST = ["unindexable-name", "normalized-name-collision"] as const;
type NameLimitationReason = (typeof NAME_LIMITATION_REASON_LIST)[number];

const NAME_LIMITATION_REASONS: ReadonlySet<ContentIndexLimitation["reason"]> = new Set(
  NAME_LIMITATION_REASON_LIST,
);

const NAVIGATION_LIMITATION_REASONS: ReadonlySet<ContentIndexLimitation["reason"]> = new Set([
  "page-not-indexed",
  "outside-repository",
  "unreadable-navigation",
  "unsupported-navigation",
]);

/**
 * True when a limitation leaves navigation incomplete. A skipped symlink, or
 * an anchor whose lines stay in the section before it, leaves every
 * navigation edge in place.
 */
export function isNavigationLimitation(limitation: ContentIndexLimitation): boolean {
  return NAVIGATION_LIMITATION_REASONS.has(limitation.reason);
}

// Kept beside the index rather than in it, so recording a limitation leaves
// every index shape and digest unchanged.
const INDEX_LIMITATIONS = new WeakMap<object, readonly ContentIndexLimitation[]>();

/**
 * What an index recorded instead of stopping, in discovery and navigation
 * order. None of it is content a task needs; a caller decides how to show it.
 */
export function contentIndexLimitations(index: object): readonly ContentIndexLimitation[] {
  return INDEX_LIMITATIONS.get(index) ?? [];
}

/** One operator sentence for a limitation, with control and format code points escaped. */
export function describeContentIndexLimitation(limitation: ContentIndexLimitation): string {
  return escapeControlText(limitationSentence(limitation));
}

const ASSET_LIMITATION_REASONS: ReadonlySet<ContentIndexLimitation["reason"]> = new Set(
  ASSET_LIMITATION_REASON_LIST,
);

/**
 * One run-record warning for each linked asset the index left out past a
 * limit, naming the asset, the page that links it, the limit, and the
 * observed value. The run record keeps warnings of up to 1,024 characters, so
 * a warning whose paths would pass that keeps the limit and names the asset by
 * the SHA-256 of its path instead. Two assets left out the same way therefore
 * stay two warnings.
 */
export function contentIndexAssetWarnings(index: object): readonly string[] {
  return contentIndexLimitations(index)
    .filter((limitation) => ASSET_LIMITATION_REASONS.has(limitation.reason))
    .map((limitation) => {
      const full = `${CONTENT_INDEX_ASSET_WARNING_CODE}: ${describeContentIndexLimitation(limitation)}`;
      if (full.length <= 1_024) return full;
      return hashedPathWarning(CONTENT_INDEX_ASSET_WARNING_CODE, limitation);
    });
}

/**
 * One run-record warning for each file, or directory, the index left out
 * under its on-disk name: the name, escaped, and what about it the index
 * cannot hold. A step's context preflight records them, so `docsfab runs show`
 * lists them under LIMITATIONS; none of them stops a step. Like an asset
 * warning, one whose path would pass the record's 1,024 characters names the
 * file or directory by the SHA-256 of its path, so two such names stay two
 * warnings.
 */
export function contentIndexNameWarnings(index: object): readonly string[] {
  return contentIndexLimitations(index)
    .filter((limitation) => NAME_LIMITATION_REASONS.has(limitation.reason))
    .map((limitation) => {
      const full = `${CONTENT_INDEX_NAME_WARNING_CODE}: ${describeContentIndexLimitation(limitation)}`;
      if (full.length <= 1_024) return full;
      return hashedPathWarning(CONTENT_INDEX_NAME_WARNING_CODE, limitation);
    });
}

/**
 * The run-record warning for a limitation whose full sentence would pass the
 * record's 1,024 characters. It keeps the code, the scope, the cause, and the
 * remedy, and names each path by the SHA-256 of its text instead: a left-out
 * directory still covers every page under it, and a name collision still
 * names the file the index kept.
 */
function hashedPathWarning(code: string, limitation: ContentIndexLimitation): string {
  const detail = escapeControlText(limitation.detail ?? limitation.reason);
  const hashed = `with path SHA-256 ${sha256(limitation.path)}`;
  if (ASSET_LIMITATION_REASONS.has(limitation.reason)) {
    return `${code}: a linked asset whose path is too long to show here, ${hashed}, is left out of the content index. ${detail}`;
  }
  if (limitation.directory) {
    return `${code}: a directory whose path is too long to show here, ${hashed}, is left out of the content index, with every page under it: ${detail}. Rename it to index its pages.`;
  }
  if (limitation.resolvedPath !== undefined) {
    return `${code}: a file whose path is too long to show here, ${hashed}, is left out of the content index: ${detail}; the kept file has path SHA-256 ${sha256(limitation.resolvedPath)}. Rename one of them to index both.`;
  }
  return `${code}: a file whose path is too long to show here, ${hashed}, is left out of the content index: ${detail}. Rename it to index it.`;
}

/**
 * The run-record warning for a workspace content index that could not be
 * built: the refusal's own sentence, which names the page and the reason, with
 * control characters escaped (#1932). The run record keeps warnings of up to
 * 1,024 characters, so a sentence whose path would pass that keeps the code
 * and drops the path.
 */
export function contentIndexIncompleteWarning(error: ContentIndexError): string {
  const effect =
    "Governed search continues without the content index, and the probes that need it report local-index-incomplete. Fix what the sentence names, then rerun the same command.";
  const full = `${CONTENT_INDEX_INCOMPLETE_WARNING_CODE}: ${escapeControlText(error.message)} ${effect}`;
  if (full.length <= 1_024) return full;
  return `${CONTENT_INDEX_INCOMPLETE_WARNING_CODE}: the content index stopped with ${error.code} at a page whose path is too long to show here. ${effect}`;
}

function limitationSentence(limitation: ContentIndexLimitation): string {
  const source = limitation.path;
  const entry = displayNavigationText(limitation.entry ?? "");
  if (limitation.reason === "unindexable-name") {
    return limitation.directory
      ? `${displayLeftOutName(source)} is a directory the content index leaves out, with every page under it: ${limitation.detail ?? limitation.reason}. Rename it to index its pages.`
      : `${displayLeftOutName(source)} is left out of the content index: ${limitation.detail ?? limitation.reason}. Rename it to index it.`;
  }
  if (limitation.reason === "normalized-name-collision") {
    return `${displayLeftOutName(source)} is left out of the content index: ${limitation.detail ?? limitation.reason}, ${displayLeftOutName(limitation.resolvedPath ?? "")}, which the index keeps. Rename one of them to index both.`;
  }
  if (limitation.reason === "empty-page-anchor" || limitation.reason === "duplicate-page-anchor") {
    return `${limitation.detail ?? `${displayNavigationText(source)} has an anchor the content index cannot admit.`} The content index leaves that anchor out and continues.`;
  }
  if (ASSET_LIMITATION_REASONS.has(limitation.reason)) {
    const linked = limitation.linkedFrom
      ? `, linked from ${displayNavigationText(limitation.linkedFrom)},`
      : "";
    return `${displayNavigationText(source)}${linked} is left out of the content index. ${limitation.detail ?? limitation.reason}`;
  }
  if (limitation.reason === "unsupported-navigation") {
    return `${source} is a JavaScript or TypeScript navigation file, which DocsFab never runs, so the content index has no navigation from it.`;
  }
  if (limitation.reason === "symlink-outside-repository") {
    return `${displayNavigationText(source)} is a symlink that leads outside the repository or nowhere; the content index skips it and never follows it.`;
  }
  if (limitation.reason === "unreadable-navigation") {
    return `${source} could not be read as navigation (${limitation.detail ?? "unreadable"}), so the content index has no navigation from it.`;
  }
  if (limitation.reason === "outside-repository") {
    return `${source} lists ${entry}, which resolves outside the repository; navigation skips it.`;
  }
  const resolved = limitation.resolvedPath ?? "";
  const forms = MARKDOWN_EXTENSION.test(resolved)
    ? ""
    : " (with or without .md, .mdx, README.md, or index.md)";
  return `${source} lists ${entry}, which resolves to ${displayNavigationText(resolved)}${forms}, a page the content index does not contain; navigation skips it.`;
}

function recordIndexLimitations<T extends object>(
  index: T,
  limitations: readonly ContentIndexLimitation[],
): T {
  INDEX_LIMITATIONS.set(index, Object.freeze([...limitations]));
  return index;
}

/** A target path, or a page under a target directory. */
function isTargetPath(path: string, targetPaths: readonly string[]): boolean {
  return targetPaths.some((target) => path === target || path.startsWith(`${target}/`));
}

/** Records each anchor problem on one page as a limitation naming the page and line. */
function pageAnchorRecorder(
  path: string,
  limitations: ContentIndexLimitation[],
): PageAnchorRecorder {
  return (problem) => {
    limitations.push({ path, reason: problem.code, line: problem.line, detail: problem.message });
  };
}

/**
 * Text with control, format, and separator code points written as `\u{...}`:
 * the shared reader-facing set (`shared/display-text.ts`), which
 * context-preflight cause messages use too.
 */
function escapeControlText(value: string): string {
  return escapeUndisplayable(value);
}

/** Quoted repository text with control, format, and separator code points escaped. */
export function quotedRepositoryText(value: string): string {
  return displayNavigationText(value);
}

/**
 * Quoted repository text with control, format, and separator code points
 * escaped. `JSON.stringify` writes C0 controls as `\uXXXX` itself.
 */
function displayNavigationText(value: string): string {
  return escapeUndisplayable(JSON.stringify(value));
}

/**
 * A left-out on-disk name, quoted and escaped like navigation text, with each
 * combining mark escaped too, so a decomposed spelling reads apart from the
 * composed one it collides with.
 */
function displayLeftOutName(value: string): string {
  return displayNavigationText(value).replace(/\p{M}/gu, escapeCodePoint);
}

interface NavigationTarget {
  /** The entry as the navigation source spells it. */
  readonly entry: string;
  /** The repository path the entry resolves to, or `undefined` outside the repository. */
  readonly path: string | undefined;
}

type NavigationReading =
  | { readonly groups: readonly (readonly NavigationTarget[])[] }
  | { readonly unreadable: string };

interface NavigationContext {
  /** A focused index's selection and coverage. */
  readonly scope?: FocusedScopeState;
  /** In-repository symlinks the untargeted walk admitted, alias to target. */
  readonly aliases?: ReadonlyMap<string, string>;
  /** The include set an unscoped index was narrowed to. */
  readonly includePaths?: readonly string[];
  /**
   * Whether a repository directory exists, decided from the repository
   * rather than from the pages this index selected.
   */
  readonly hasDirectory: (path: string) => boolean;
}

function navigation(
  sources: SourceFile[],
  byPath: Map<string, Pick<ParsedDocumentV3, "id">>,
  context: NavigationContext,
): { edges: StructuralEdge[]; limitations: ContentIndexLimitation[] } {
  const { scope, aliases = new Map<string, string>(), hasDirectory } = context;
  // Pages outside the selection were never indexed: an entry naming one
  // breaks the chain, but it is no limitation of the repository.
  const includePaths = scope?.includePaths ?? context.includePaths;
  const edges: StructuralEdge[] = [];
  const limitations: ContentIndexLimitation[] = [];
  for (const source of sources.sort((left, right) => compareText(left.path, right.path))) {
    if (UNSUPPORTED_NAVIGATION_NAMES.has(posix.basename(source.path))) {
      // Executable navigation is never run, so it is unknown navigation. A
      // focused index reached it on a target's ancestor chain, where it is
      // required context: coverage is incomplete, never complete.
      scope?.coverage.incompleteNavigationPaths.push(source.path);
      limitations.push({ path: source.path, reason: "unsupported-navigation" });
      continue;
    }
    const reading = readNavigation(source, hasDirectory);
    if ("unreadable" in reading) {
      scope?.coverage.incompleteNavigationPaths.push(source.path);
      limitations.push({
        path: source.path,
        reason: "unreadable-navigation",
        detail: reading.unreadable,
      });
      continue;
    }
    // An entry listed more than once is recorded once.
    const recorded = new Set<string>();
    const record = (limitation: ContentIndexLimitation): undefined => {
      const entry = limitation.entry ?? "";
      if (!recorded.has(entry)) {
        recorded.add(entry);
        limitations.push(limitation);
      }
      return undefined;
    };
    for (const targets of reading.groups) {
      // `undefined` breaks the chain, so the pages around an entry the index
      // cannot link never become fake neighbours.
      const documents = targets.map((target) => {
        if (target.path === undefined) {
          return record({
            path: source.path,
            reason: "outside-repository",
            entry: target.entry,
          });
        }
        const resolved = documentCandidates(target.path)
          .map((path) => byPath.get(path) ?? byPath.get(throughAlias(path, aliases) ?? ""))
          .find(Boolean);
        if (resolved) return resolved;
        // Handles only an entry naming a page the walk already skipped as a
        // (c) alias (`latest.md -> v2.md` listed in a root `_toc.yml`).
        if (scope && navigationTargetIsSkippedAlias(target.path, scope.coverage)) {
          scope.coverage.aliasNavigationTargets += 1;
          return undefined;
        }
        const selectedPath = throughAlias(target.path, aliases) ?? target.path;
        if (includePaths && navigationTargetOutsideScope(selectedPath, includePaths)) {
          if (scope) scope.coverage.outOfScopeNavigationTargets += 1;
          return undefined;
        }
        return record({
          path: source.path,
          reason: "page-not-indexed",
          entry: target.entry,
          resolvedPath: target.path,
        });
      });
      for (let index = 1; index < documents.length; index += 1) {
        const from = documents[index - 1];
        const to = documents[index];
        if (from && to) edges.push({ kind: "navigation", from: from.id, to: to.id });
      }
    }
  }
  return { edges, limitations };
}

/**
 * True only when no candidate page for a navigation entry could have been
 * indexed under the focused include set.
 */
function navigationTargetOutsideScope(path: string, includePaths: readonly string[]): boolean {
  return documentCandidates(path).every(
    (candidate) => !shouldIncludeSource(candidate, includePaths),
  );
}

/** True when a navigation entry names a page the focused walk skipped as an optional alias. */
function navigationTargetIsSkippedAlias(path: string, coverage: ScopedIndexCoverage): boolean {
  return documentCandidates(path).some((candidate) =>
    coverage.skippedOptionalAliasPaths.includes(candidate),
  );
}

/** The path an admitted in-repository symlink, or a directory symlink above it, stands for. */
function throughAlias(path: string, aliases: ReadonlyMap<string, string>): string | undefined {
  for (const [alias, target] of aliases) {
    if (path === alias) return target;
    if (path.startsWith(`${alias}/`)) {
      const rest = path.slice(alias.length + 1);
      return target ? `${target}/${rest}` : rest;
    }
  }
  return undefined;
}

/** Target groups in navigation order, or why the navigation source cannot be used. */
function readNavigation(
  source: SourceFile,
  hasDirectory: (path: string) => boolean,
): NavigationReading {
  const name = posix.basename(source.path);
  const base = repositoryDirectory(posix.dirname(source.path)) ?? "";
  if (name === "sidebars.json") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(source.contents) as unknown;
    } catch {
      return { unreadable: "it is not valid JSON" };
    }
    return {
      groups: docusaurusSidebarGroups(parsed).map((group) =>
        group.map((entry) => navigationTarget(base, entry)),
      ),
    };
  }
  if (name === "mkdocs.yml" || name === "mkdocs.yaml") {
    return readMkdocsNavigation(source, base, hasDirectory);
  }
  // A Jupyter Book table of contents names pages with `root:` and `file:`
  // entries, relative to the table of contents.
  const targets: NavigationTarget[] = [];
  for (const line of source.contents.split("\n")) {
    const entry = line.match(/^\s*(?:-\s*)?(?:root|file):\s*["']?([^"'#]+)["']?\s*$/u)?.[1]?.trim();
    if (entry) targets.push(navigationTarget(base, entry));
  }
  return { groups: [targets] };
}

/**
 * MkDocs navigation: only the `nav` tree, resolved against `docs_dir`. A
 * configuration without `nav` has no explicit navigation, and plugin settings
 * are never read as entries. The document is parsed but never converted as a
 * whole: only `nav` and `docs_dir` are read, by a walk that spends one unit
 * of a budget equal to the file's byte length for every node it visits and
 * every alias it follows, plus one unit for each character of every nav entry
 * it reads. Without aliases a file cannot hold more nodes or entry characters
 * than bytes, so only alias expansion can run the budget out, and it is
 * recorded, never followed further. Aliases under any other key, such as
 * `extra`, are never resolved. The parse itself is outside the budget; error
 * messages are left unformatted and `!!omap` is not checked, so it stays
 * close to linear in the file's size.
 */
function readMkdocsNavigation(
  source: SourceFile,
  base: string,
  hasDirectory: (path: string) => boolean,
): NavigationReading {
  let document: ReturnType<typeof parseYamlDocument>;
  let aliasTargets: ReadonlyMap<object, unknown>;
  try {
    // PyYAML reads MkDocs configuration as YAML 1.1 and keeps the last of a
    // repeated key. Tags such as `!!python/name:` only warn here. `<<` is
    // read as a plain key; the walk merges the two settings it reads by hand.
    document = parseYamlDocument(source.contents, {
      version: "1.1",
      uniqueKeys: false,
      prettyErrors: false,
      customTags: (tags) =>
        tags.filter((tag) =>
          typeof tag === "string"
            ? tag !== "merge" && tag !== "omap"
            : tag.tag !== YAML_MERGE_TAG && tag.tag !== YAML_OMAP_TAG,
        ),
    });
    if (document.errors.some((error) => error.code === "RESOURCE_EXHAUSTION")) {
      return { unreadable: "it is too large or too deeply nested to read" };
    }
    if (document.errors.length > 0) return { unreadable: "it is not valid YAML" };
    const targets = yamlAliasTargets(document);
    if (targets === undefined) return { unreadable: "it is not valid YAML" };
    aliasTargets = targets;
  } catch {
    return { unreadable: "it is too large or too deeply nested to read" };
  }
  const walk: YamlWalk = { aliasTargets, remaining: source.byteLength };
  const nav = mkdocsSetting(document.contents, "nav", walk);
  if (typeof nav === "string") return { unreadable: nav };
  if (nav === undefined || (isScalar(nav) && nav.value === null)) return { groups: [] };
  const docsDir = mkdocsSetting(document.contents, "docs_dir", walk);
  if (typeof docsDir === "string") return { unreadable: docsDir };
  const configured = mkdocsDocsDir(docsDir, walk);
  if (typeof configured === "object") return configured;
  const entries = mkdocsNavigationEntries(nav, walk);
  if (typeof entries === "string") return { unreadable: entries };
  const root = mkdocsDocsRoot(base, configured, hasDirectory);
  if (typeof root === "object") return root;
  // An entry listed many times, as through an alias, shares one target.
  const distinct = new Map<string, NavigationTarget>();
  const targets: NavigationTarget[] = [];
  for (const entry of entries) {
    if (isExternalTarget(entry) || entry.startsWith("/") || !MARKDOWN_EXTENSION.test(entry)) {
      continue;
    }
    let target = distinct.get(entry);
    if (!target) {
      target = navigationTarget(root, entry);
      distinct.set(entry, target);
    }
    targets.push(target);
  }
  return { groups: [targets] };
}

const YAML_ALIAS_EXPANSION = "it expands too many YAML aliases";
const YAML_SELF_CONTAINING_NAV = "its nav contains itself through a YAML alias";

/** What the MkDocs walk may spend, and where each alias leads. */
interface YamlWalk {
  readonly aliasTargets: ReadonlyMap<object, unknown>;
  remaining: number;
}

/**
 * The node each alias names: the last anchor of its name before it, in
 * document order, found in one pass that resolves nothing. `undefined` when
 * an alias names no anchor.
 */
function yamlAliasTargets(
  document: ReturnType<typeof parseYamlDocument>,
): ReadonlyMap<object, unknown> | undefined {
  const anchors = new Map<string, unknown>();
  const targets = new Map<object, unknown>();
  let unresolved = false;
  visitYaml(document, {
    Node(_key, node) {
      if (isAlias(node)) {
        if (!anchors.has(node.source)) unresolved = true;
        else targets.set(node, anchors.get(node.source));
        return;
      }
      if (node.anchor) anchors.set(node.anchor, node);
    },
  });
  return unresolved ? undefined : targets;
}

/** Spends units of the walk's budget, one by default, or reports that it ran out. */
function spendYamlWalk(walk: YamlWalk, units = 1): boolean {
  walk.remaining -= units;
  return walk.remaining >= 0;
}

/** Follows aliases to the node they name, spending one unit per dereference. */
function dereferenceYaml(node: unknown, walk: YamlWalk): unknown | typeof YAML_ALIAS_EXPANSION {
  let current = node;
  while (isAlias(current)) {
    if (!spendYamlWalk(walk)) return YAML_ALIAS_EXPANSION;
    current = walk.aliasTargets.get(current);
  }
  return current;
}

/**
 * A top-level MkDocs setting's node, or the same setting from the maps a `<<`
 * key names: an explicit key wins over merged maps, which are taken in order,
 * and the last of a repeated key wins. A string is why it could not be read.
 */
function mkdocsSetting(root: unknown, key: string, walk: YamlWalk): unknown {
  const seen = new Set<unknown>();
  const pending: unknown[] = [root];
  // An index, not shift(), so a long merge list stays linear.
  for (let next = 0; next < pending.length; next += 1) {
    const map = dereferenceYaml(pending[next], walk);
    if (map === YAML_ALIAS_EXPANSION) return map;
    if (!isMap(map) || seen.has(map)) continue;
    seen.add(map);
    const merged: unknown[] = [];
    let found: { value: unknown } | undefined;
    for (const pair of map.items) {
      if (!spendYamlWalk(walk)) return YAML_ALIAS_EXPANSION;
      const name = isScalar(pair.key) ? pair.key.value : undefined;
      if (name === key) found = { value: pair.value ?? null };
      else if (name === "<<") {
        const value = dereferenceYaml(pair.value, walk);
        if (value === YAML_ALIAS_EXPANSION) return value;
        // Loops, not spreads: a merge list may hold more maps than a call's arguments.
        if (isSeq(value)) for (const item of value.items) merged.push(item);
        else merged.push(value);
      }
    }
    if (found) return found.value;
    for (const item of merged) pending.push(item);
  }
  return undefined;
}

/**
 * `docs_dir` as MkDocs reads it. A plain scalar is read from its source text,
 * as PyYAML reads `.` (a YAML 1.1 float needs a digit); null or empty keeps
 * the default.
 */
function mkdocsDocsDir(
  setting: unknown,
  walk: YamlWalk,
): string | undefined | { readonly unreadable: string } {
  const node = dereferenceYaml(setting, walk);
  if (node === YAML_ALIAS_EXPANSION) return { unreadable: node };
  if (node === undefined || node === null) return undefined;
  if (isScalar(node)) {
    if (node.type === "PLAIN") {
      const text = node.source ?? "";
      return /^(?:~|null|Null|NULL)?$/u.test(text) ? undefined : text;
    }
    if (typeof node.value === "string") return node.value;
  }
  return { unreadable: "its docs_dir is not a path" };
}

/**
 * The directory MkDocs reads pages from: `docs_dir` beside the configuration,
 * `docs` by default. Without `docs_dir` and with no `docs` directory beside
 * the configuration, a layout MkDocs itself cannot build, entries resolve
 * beside the configuration as they did before `docs_dir` was read. Whether a
 * directory exists comes from the repository, never from the pages an index
 * selected. A configured `docs_dir` outside the repository, or naming no
 * directory in it, is recorded once for the whole configuration.
 */
function mkdocsDocsRoot(
  base: string,
  configured: string | undefined,
  hasDirectory: (path: string) => boolean,
): string | { readonly unreadable: string } {
  const outside = { unreadable: "its docs_dir is outside the repository" };
  if (configured !== undefined && (isAbsolute(configured) || configured.startsWith("/"))) {
    return outside;
  }
  const root = repositoryDirectory(posix.join(base, configured ?? "docs"));
  if (root === undefined) return outside;
  if (hasDirectory(root)) return root;
  if (configured === undefined) return base;
  return { unreadable: "its docs_dir names no directory in the repository" };
}

/**
 * Whether a repository directory exists on disk, as a directory or a symlink,
 * or as a tracked symlink that a materialized export leaves absent.
 */
function repositoryDirectoriesOnDisk(
  root: string,
  trackedAliasPaths: readonly string[],
): (path: string) => boolean {
  const aliases = new Set(trackedAliasPaths.map((path) => requestedPathKey(path)));
  const known = new Map<string, boolean>();
  return (path) => {
    let exists = known.get(path);
    if (exists === undefined) {
      try {
        const entry = lstatSync(resolve(root, ...path.split("/").filter(Boolean)));
        exists = entry.isDirectory() || entry.isSymbolicLink();
      } catch {
        exists = false;
      }
      exists ||= aliases.has(path);
      known.set(path, exists);
    }
    return exists;
  };
}

/** Every directory that holds a tracked file, and every tracked symlink. */
async function trackedDirectories(
  workspace: unknown,
  trackedFiles: readonly { readonly path: string }[],
): Promise<(path: string) => boolean> {
  const directories = new Set<string>();
  for (const file of trackedFiles) {
    for (const directory of ancestorDirectories(file.path)) directories.add(directory);
  }
  for (const entry of await listTrackedRepositoryEntries(workspace)) {
    if (entry.kind === "symlink" && entry.path !== undefined) directories.add(entry.path);
  }
  return (path) => directories.has(path);
}

/**
 * Every string leaf of a MkDocs `nav` tree, in navigation order, or why the
 * tree cannot be read: it contains itself, or reading it would pass the walk's
 * budget. A YAML alias inside its own anchor makes such a cycle; a repeated
 * alias elsewhere is no cycle and is read again, spending budget. Each entry
 * read spends its length too, so an alias cannot repeat a long entry past the
 * file's size.
 */
function mkdocsNavigationEntries(nav: unknown, walk: YamlWalk): string[] | string {
  const entries: string[] = [];
  // Collections on the path from the root to the item being read.
  const open = new Set<unknown>();
  const pending: Array<{ readonly item: unknown } | { readonly leave: unknown }> = [{ item: nav }];
  while (pending.length > 0) {
    const next = pending.pop()!;
    if ("leave" in next) {
      open.delete(next.leave);
      continue;
    }
    if (!spendYamlWalk(walk)) return YAML_ALIAS_EXPANSION;
    const item = dereferenceYaml(next.item, walk);
    if (item === YAML_ALIAS_EXPANSION) return item;
    if (isScalar(item)) {
      if (typeof item.value === "string") {
        if (!spendYamlWalk(walk, item.value.length)) return YAML_ALIAS_EXPANSION;
        entries.push(item.value);
      }
      continue;
    }
    if (!isSeq(item) && !isMap(item)) continue;
    if (open.has(item)) return YAML_SELF_CONTAINING_NAV;
    const children = isSeq(item) ? item.items : item.items.map((pair) => pair.value);
    open.add(item);
    pending.push({ leave: item });
    for (let index = children.length - 1; index >= 0; index -= 1) {
      pending.push({ item: children[index] });
    }
  }
  return entries;
}

function navigationTarget(base: string, entry: string): NavigationTarget {
  try {
    return { entry, path: normalizeRelativePath(posix.join(base, entry)) };
  } catch (error) {
    if (error instanceof ContentIndexError && error.code === "unsafe-path") {
      return { entry, path: undefined };
    }
    throw error;
  }
}

/** A repository-relative directory, `""` for the root, or `undefined` outside the repository. */
function repositoryDirectory(value: string): string | undefined {
  const normalized = posix.normalize(value);
  if (normalized === "." || normalized === "./") return "";
  if (normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/")) {
    return undefined;
  }
  return normalized.replace(/\/$/u, "");
}

function resolveDocumentPath(
  sourcePath: string,
  rawTarget: string,
  byPath: Map<string, ParsedDocument>,
): ParsedDocument | undefined {
  const decoded = rawTarget.split("?", 1)[0]!;
  if (isAbsolute(decoded) || decoded.startsWith("/")) return undefined;
  const normalized = normalizeRelativePath(posix.join(posix.dirname(sourcePath), decoded));
  if (normalized === ".." || normalized.startsWith("../")) return undefined;
  return documentCandidates(normalized)
    .map((path) => byPath.get(path))
    .find(Boolean);
}

function resolveDocumentPathV3(
  sourcePath: string,
  rawTarget: string,
  byPath: Map<string, ParsedDocumentV3>,
): ParsedDocumentV3 | undefined {
  const decoded = rawTarget.split("?", 1)[0]!;
  if (isAbsolute(decoded) || decoded.startsWith("/")) return undefined;
  const normalized = normalizeRelativePath(posix.join(posix.dirname(sourcePath), decoded));
  if (normalized === ".." || normalized.startsWith("../")) return undefined;
  return documentCandidatesV3(normalized)
    .map((path) => byPath.get(path))
    .find(Boolean);
}

function resolveDocumentPathV1(
  sourcePath: string,
  rawTarget: string,
  byPath: Map<string, ParsedDocument>,
): ParsedDocument | undefined {
  return resolveDocumentPath(sourcePath, safeDecodeV1(rawTarget.split("?", 1)[0]!), byPath);
}

async function existingOpaqueTargetV1(
  repositoryRoot: string,
  sourcePath: string,
  rawTarget: string,
): Promise<string | undefined> {
  const decoded = safeDecodeV1(rawTarget.split("?", 1)[0]!);
  if (!decoded || isAbsolute(decoded) || decoded.startsWith("/")) return undefined;
  const normalized = normalizeRelativePath(posix.join(posix.dirname(sourcePath), decoded));
  const absolute = resolve(repositoryRoot, ...normalized.split("/"));
  try {
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink() || (!metadata.isFile() && !metadata.isDirectory())) {
      throw new ContentIndexError(
        "unsafe-path",
        `Content index rejects unsafe internal target: ${normalized}.`,
      );
    }
    if ((await realpath(absolute)) !== absolute) {
      throw new ContentIndexError(
        "unsafe-path",
        `Content index rejects non-canonical internal target: ${normalized}.`,
      );
    }
    return normalized;
  } catch (error) {
    if (error instanceof ContentIndexError) throw error;
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      return undefined;
    }
    throw new ContentIndexError(
      "tracked-file-unreadable",
      `Content index could not inspect internal target: ${normalized}.`,
    );
  }
}

function documentCandidates(path: string): string[] {
  if (MARKDOWN_EXTENSION.test(path)) return [path];
  const trimmed = path.replace(/\/$/u, "");
  return [
    `${trimmed}.md`,
    `${trimmed}.mdx`,
    `${trimmed}/README.md`,
    `${trimmed}/index.md`,
    `${trimmed}/index.mdx`,
  ];
}

function documentCandidatesV3(path: string): string[] {
  if (MARKDOWN_EXTENSION.test(path) || RST_EXTENSION.test(path)) return [path];
  const trimmed = path.replace(/\/$/u, "");
  return [
    `${trimmed}.md`,
    `${trimmed}.mdx`,
    `${trimmed}.rst`,
    `${trimmed}/README.md`,
    `${trimmed}/index.md`,
    `${trimmed}/index.mdx`,
    `${trimmed}/index.rst`,
  ];
}

function edgeTouchesDocument(edge: StructuralEdge, document: ParsedDocument): boolean {
  return (
    edge.from === document.id ||
    edge.to === document.id ||
    document.headings.some((heading) => heading.id === edge.from || heading.id === edge.to)
  );
}

function edgeTouchesDocumentV2(
  edge: StructuralEdgeV2,
  document: Pick<ParsedDocumentV3, "id" | "headings">,
): boolean {
  return (
    edge.from === document.id ||
    edge.to === document.id ||
    document.headings.some((heading) => heading.id === edge.from || heading.id === edge.to)
  );
}

function structuralGraphEdgeV2(edge: StructuralEdgeV2): unknown {
  if (edge.kind !== "asset-link") return edge;
  return {
    ...edge,
    target: {
      kind: edge.target.kind,
      sourcePath: edge.target.sourcePath,
      digest: edge.target.digest,
    },
  };
}

function uniqueEdges(edges: StructuralEdge[]): StructuralEdge[] {
  const map = new Map<string, StructuralEdge>();
  for (const edge of edges) map.set(`${edge.kind}\0${edge.from}\0${edge.to}`, edge);
  return [...map.values()].sort((left, right) =>
    compareText(
      `${left.kind}\0${left.from}\0${left.to}`,
      `${right.kind}\0${right.from}\0${right.to}`,
    ),
  );
}

function uniqueEdgesV2(edges: StructuralEdgeV2[]): StructuralEdgeV2[] {
  const map = new Map<string, StructuralEdgeV2>();
  for (const edge of edges) map.set(`${edge.kind}\0${edge.from}\0${edge.to}`, edge);
  return [...map.values()].sort((left, right) =>
    compareText(
      `${left.kind}\0${left.from}\0${left.to}`,
      `${right.kind}\0${right.from}\0${right.to}`,
    ),
  );
}

/**
 * Two pages with one identity, the same frontmatter `id`, stop the index. The
 * refusal names both pages, so the record of a step that continues without
 * context says which ones to fix.
 */
function assertUniqueDocuments(
  documents: readonly { readonly id: string; readonly sourcePath: string }[],
): void {
  const seen = new Map<string, string>();
  for (const document of documents) {
    const first = seen.get(document.id);
    if (first !== undefined) {
      // hygiene: envelope - code-bearing ContentIndexError is rendered by the host boundary.
      throw new ContentIndexError(
        "duplicate-node-identity",
        `Content index contains a duplicate document identity: ${displayNavigationText(first)} and ${displayNavigationText(document.sourcePath)} share one. Give each page its own frontmatter id.`,
      );
    }
    seen.set(document.id, document.sourcePath);
  }
}

type ExplicitAnchorKind = "explicit anchor" | "MyST label" | "HTML id";

/** Registers an explicit anchor, or returns why the page cannot admit it. */
function addExplicitAnchor(
  anchors: Map<string, number>,
  anchor: string,
  sourcePath: string,
  line: number,
  kind: ExplicitAnchorKind,
): string | PageAnchorProblem {
  if (!anchor) {
    return {
      code: "empty-page-anchor",
      line,
      message: `The ${kind} at line ${line} of ${sourcePath} has no letter or digit to form an anchor. Add a letter or digit to it, or remove it.`,
    };
  }
  const firstLine = anchors.get(anchor);
  if (firstLine !== undefined) {
    return {
      code: "duplicate-page-anchor",
      line,
      message: `The ${kind} at line ${line} of ${sourcePath} repeats the anchor defined at line ${firstLine}. Rename one of them so each anchor on the page is unique.`,
    };
  }
  anchors.set(anchor, line);
  return anchor;
}

/**
 * Registers a heading's generated anchor, suffixed when the page already uses
 * it, or returns why it has none. `underline` is the line of a setext
 * heading's `---` or `===`; ATX headings have none.
 */
function addGeneratedAnchor(
  anchors: Map<string, number>,
  requested: string,
  sourcePath: string,
  line: number,
  underline: number | undefined,
): string | PageAnchorProblem {
  if (!requested) {
    return {
      code: "empty-page-anchor",
      line,
      message:
        underline === undefined
          ? `The heading at line ${line} of ${sourcePath} has no letter or digit to form an anchor. Add a letter or digit to the heading text, or give the heading an explicit {#anchor}.`
          : `Line ${underline} of ${sourcePath} underlines line ${line} as a heading that has no letter or digit to form an anchor. If line ${underline} is a thematic break, put a blank line before it; otherwise add a letter or digit to the heading text.`,
    };
  }
  let anchor = requested;
  let suffix = 1;
  while (anchors.has(anchor)) anchor = `${requested}-${suffix++}`;
  anchors.set(anchor, line);
  return anchor;
}

/**
 * Whether a line is paragraph text, the only text a setext underline can turn
 * into a heading. A line that opens another block, such as a heading, thematic
 * break, block quote, list item, colon fence, or HTML block, is not, and
 * neither is a line holding only HTML or JSX tags. An indented line continues
 * an open paragraph but cannot start one.
 */
function isParagraphText(line: string, continuesParagraph: boolean): boolean {
  if (!line.trim()) return false;
  if (
    ATX_HEADING_START.test(line) ||
    SETEXT_UNDERLINE.test(line) ||
    THEMATIC_BREAK.test(line) ||
    BLOCK_QUOTE_START.test(line) ||
    LIST_ITEM_START.test(line) ||
    COLON_FENCE.test(line) ||
    HTML_BLOCK_START.test(line) ||
    TAG_ONLY_LINE.test(line)
  ) {
    return false;
  }
  return continuesParagraph || !INDENTED_CODE.test(line);
}

function normalizeAnchor(value: string): string {
  return value
    .normalize("NFC")
    .toLowerCase()
    .replace(/<[^>]+>/gu, "")
    .replace(/[`*_~]/gu, "")
    .replace(/[^\p{Letter}\p{Number}\s_-]/gu, "")
    .trim()
    .replace(/[\s_]+/gu, "-")
    .replace(/-+/gu, "-");
}

/**
 * A link or navigation target as a repository path. A backslash in a target
 * reads as a separator, the way Markdown authors on Windows write one.
 */
function normalizeRelativePath(value: string): string {
  return requestedPathKey(value.replace(/\\/gu, "/"));
}

/**
 * A path a caller names, an include path, a target, or a tracked alias, as
 * the index names files: posix-normalized and NFC. A backslash stays part of
 * the name it is in, as it is on disk, so a request never resolves to a
 * different file than the one it names.
 */
function requestedPathKey(value: string): string {
  const normalized = posix.normalize(value).normalize("NFC");
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/") ||
    normalized.split("/").includes("..")
  ) {
    // hygiene: envelope - code-bearing ContentIndexError is rendered by the host boundary.
    throw new ContentIndexError("unsafe-path", "Content index path escapes the repository.");
  }
  return normalized;
}

function normalizeBodyLine(line: string): string {
  return line
    .replace(/^ {0,3}(\[[^\]]+\]:)\s*(?:<[^>]+>|\S+)(?:\s+.*)?$/u, "$1")
    .replace(/(!?\[[^\]]*\])\(<(?:\\.|[^<>\\])*?(?:>)(?:\s+["'][^"']*["'])?\)/gu, "$1()")
    .replace(/(!?\[[^\]]*\])\((?!<)([^)\s]+)(?:\s+["'][^"']*["'])?\)/gu, "$1()")
    .replace(/(<a\s+[^>]*href=)["'][^"']+["']/giu, '$1""')
    .trimEnd();
}

function unescapeMarkdownDestination(value: string): string {
  return value.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~])/gu, "$1");
}

function isExternalTarget(target: string): boolean {
  return /^(?:[A-Za-z][A-Za-z\d+.-]*:|\/\/)/u.test(target);
}

function decodeInternalTarget(
  value: string,
  document: Pick<ParsedDocumentV3, "sourcePath">,
  line: number,
): string {
  try {
    const decoded = decodeURIComponent(value);
    if (
      decoded !== decoded.normalize("NFC") ||
      /[\0-\x1f\x7f]/u.test(decoded) ||
      decoded.includes("\\") ||
      /%[a-f\d]{2}/iu.test(decoded)
    ) {
      throw new URIError("unsafe target encoding");
    }
    if (decoded.startsWith("/") || isAbsolute(decoded)) {
      throw new ContentIndexError("unsafe-path", "Content index target is absolute.");
    }
    return decoded;
  } catch (error) {
    if (error instanceof ContentIndexError) throw error;
    throw new ContentIndexError(
      "invalid-internal-target",
      `Invalid encoded internal target from ${document.sourcePath} at line ${line}.`,
    );
  }
}

function parseInternalTarget(
  target: string,
  document: Pick<ParsedDocumentV3, "sourcePath">,
  line: number,
): { decodedPath: string; decodedFragment?: string } {
  const firstHash = target.indexOf("#");
  if (firstHash !== -1 && target.indexOf("#", firstHash + 1) !== -1) {
    throwInvalidInternalTarget(document, line);
  }
  const pathAndQuery = firstHash === -1 ? target : target.slice(0, firstHash);
  const rawFragment = firstHash === -1 ? undefined : target.slice(firstHash + 1);
  if (rawFragment?.includes("?")) throwInvalidInternalTarget(document, line);
  const firstQuery = pathAndQuery.indexOf("?");
  if (firstQuery !== -1 && pathAndQuery.indexOf("?", firstQuery + 1) !== -1) {
    throwInvalidInternalTarget(document, line);
  }
  const rawPath = firstQuery === -1 ? pathAndQuery : pathAndQuery.slice(0, firstQuery);
  const rawQuery = firstQuery === -1 ? undefined : pathAndQuery.slice(firstQuery + 1);
  const decodedPath = rawPath ? decodeInternalTarget(rawPath, document, line) : "";
  if (rawQuery !== undefined) decodeInternalTarget(rawQuery, document, line);
  const decodedFragment =
    rawFragment === undefined ? undefined : decodeInternalTarget(rawFragment, document, line);
  return { decodedPath, ...(decodedFragment !== undefined ? { decodedFragment } : {}) };
}

function throwInvalidInternalTarget(
  document: Pick<ParsedDocumentV3, "sourcePath">,
  line: number,
): never {
  throw new ContentIndexError(
    "invalid-internal-target",
    `Invalid encoded internal target from ${document.sourcePath} at line ${line}.`,
  );
}

function safeDecodeV1(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function docusaurusSidebarGroups(value: unknown): string[][] {
  if (Array.isArray(value)) return [docusaurusSidebarTargets(value)];
  if (!value || typeof value !== "object") return [];
  const root = value as Record<string, unknown>;
  return Object.keys(root)
    .sort(compareText)
    .flatMap((key) => {
      const sidebar = root[key];
      return Array.isArray(sidebar) ? [docusaurusSidebarTargets(sidebar)] : [];
    });
}

function docusaurusSidebarTargets(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(docusaurusSidebarTargets);
  if (!value || typeof value !== "object") return [];
  const item = value as Record<string, unknown>;
  const type = typeof item.type === "string" ? item.type : undefined;
  if (type === "doc" || type === "ref") {
    return typeof item.id === "string" ? [item.id] : [];
  }
  if (type === "category") {
    return [...docusaurusSidebarTargets(item.link), ...docusaurusSidebarTargets(item.items)];
  }
  return [];
}

function normalizeReferenceLabel(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/gu, " ").toLowerCase();
}

function normalizeHeadingText(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/gu, " ");
}

function unquote(value: string): string {
  return value.replace(/^(?:["'])(.*)(?:["'])$/u, "$1");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * A page or navigation source past contentIndex.maxSourceBytes stops the index,
 * naming the page, its size, and the limit.
 */
function assertSourceWithinLimit(
  file: { readonly path: string; readonly byteLength: number },
  limit: ResolvedLimit,
): void {
  if (file.byteLength <= limit.value) return;
  // hygiene: envelope - code-bearing ContentIndexError is rendered by the host boundary.
  throw new ContentIndexError(
    "source-too-large",
    `${file.path} is ${file.byteLength} bytes. ${formatLimitObservation(limit, file.byteLength)}`,
  );
}
