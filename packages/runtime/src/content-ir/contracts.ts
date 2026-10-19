// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** The frozen document-format enum used by ContentIndexV1 and ContentIndexV2. */
export type ContentFormat = "markdown" | "gfm" | "myst" | "mdx";

/** The explicit V3 extension; it does not widen historical formats. */
export type ContentFormatV3 = ContentFormat | "rst";

type Assert<T extends true> = T;
type HistoricalFormatExcludesRst = Assert<
  Extract<ContentFormat, "rst"> extends never ? true : false
>;

export type StructuralChangeRegion = "body" | "headings" | "metadata" | "navigation" | "graph";

export type StructuralEdgeKind =
  | "parent"
  | "child"
  | "previous-sibling"
  | "next-sibling"
  | "outbound-link"
  | "backlink"
  | "navigation";

export type StructuralEdgeKindV2 = StructuralEdgeKind | "asset-link";

export interface RepositoryIdentity {
  /** Immutable Git object ID used to create the disposable repository export. */
  revision: string;
  /** SHA-256 of the sorted repository-relative source manifest. */
  contentDigest: string;
}

export interface StructuralRegionDigests {
  body: string;
  headings: string;
  metadata: string;
  navigation: string;
  graph: string;
}

export interface FrontmatterFieldShape {
  name: string;
  type: "string" | "number" | "boolean" | "null" | "sequence" | "mapping";
}

export interface DirectiveShape {
  name: string;
  line: number;
}

export interface CodeBlockShape {
  language?: string;
  startLine: number;
  endLine: number;
}

export interface DocumentNode {
  id: string;
  kind: "document";
  sourcePath: string;
  format: ContentFormat;
  byteLength: number;
  anchors: string[];
  frontmatter: FrontmatterFieldShape[];
  directives: DirectiveShape[];
  codeBlocks: CodeBlockShape[];
  regions: StructuralRegionDigests;
}

export interface DocumentNodeV3 extends Omit<DocumentNode, "format"> {
  format: ContentFormatV3;
}

export interface SectionNode {
  id: string;
  kind: "section";
  documentId: string;
  sourcePath: string;
  anchor: string;
  depth: number;
  startLine: number;
  endLine: number;
}

/** The frozen V1/V2 node union, which cannot represent an RST document. */
export type ContentNode = DocumentNode | SectionNode;

export type ContentNodeV3 = DocumentNodeV3 | SectionNode;

export interface StructuralEdge {
  kind: StructuralEdgeKind;
  from: string;
  to: string;
}

export interface AssetTargetBinding {
  kind: "asset";
  sourcePath: string;
  repositoryRevision: string;
  digest: string;
}

export interface AssetStructuralEdge {
  kind: "asset-link";
  from: string;
  /** Stable opaque identity derived only from the repository-relative asset path. */
  to: string;
  target: AssetTargetBinding;
}

export type StructuralEdgeV2 = StructuralEdge | AssetStructuralEdge;

export interface ContentIndexEvidence {
  repositoryRevision: string;
  contentDigest: string;
  indexDigest: string;
  documentCount: number;
  sectionCount: number;
  edgeCount: number;
}

export interface ContentIndexEvidenceV2 extends ContentIndexEvidence {
  assetCount: number;
}

export interface ContentIndexV1 {
  schemaVersion: 1;
  repository: RepositoryIdentity;
  indexDigest: string;
  nodes: ContentNode[];
  edges: StructuralEdge[];
  evidence: ContentIndexEvidence;
}

export interface ContentIndexV2 {
  schemaVersion: 2;
  repository: RepositoryIdentity;
  indexDigest: string;
  nodes: ContentNode[];
  edges: StructuralEdgeV2[];
  evidence: ContentIndexEvidenceV2;
}

type HistoricalDocumentFormat = Extract<
  ContentIndexV1["nodes"][number],
  { kind: "document" }
>["format"];
type HistoricalNodesExcludeRst = Assert<
  Extract<HistoricalDocumentFormat, "rst"> extends never ? true : false
>;

/**
 * RST-aware indexes retain the exact V2 object shape. The schema version is
 * part of the digest, so admitting a new document format cannot reinterpret a
 * historical index.
 */
export interface ContentIndexV3 extends Omit<ContentIndexV2, "schemaVersion" | "nodes"> {
  schemaVersion: 3;
  nodes: ContentNodeV3[];
}

/** The historical V1/V2 compatibility union retained by existing consumers. */
export type ContentIndex = ContentIndexV1 | ContentIndexV2;

/** Every closed Content IR version that the versioned decoder understands. */
export type ContentIndexKnown = ContentIndex | ContentIndexV3;

export interface StructuralDocumentChange {
  documentId: string;
  sourcePath: string;
  previousSourcePath?: string;
  regions: StructuralChangeRegion[];
}

export interface StructuralDiff {
  schemaVersion: 1;
  fromRevision: string;
  toRevision: string;
  fromIndexDigest: string;
  toIndexDigest: string;
  regions: StructuralChangeRegion[];
  documents: StructuralDocumentChange[];
}

export interface StructuralDiffV2 extends Omit<StructuralDiff, "schemaVersion"> {
  schemaVersion: 2;
}

export interface StructuralDiffV3 extends Omit<StructuralDiff, "schemaVersion"> {
  schemaVersion: 3;
}

export interface BuildContentIndexInput {
  repositoryPath: string;
  repositoryRevision: string;
  /**
   * When set, compile only these repository-relative paths, files in their
   * ancestor directories, and descendants of directory targets.
   */
  includePaths?: readonly string[];
  /**
   * Tracked symlink paths that a materialized export leaves absent on disk.
   * The index never reads them; one only shows that a MkDocs configuration's
   * default `docs` directory exists.
   */
  trackedAliasPaths?: readonly string[];
  /**
   * Repository-relative pages, or directories of pages, that the caller must
   * read or write. A page anchor the index cannot admit stops the index with
   * its code only on one of these pages. On any other page the index leaves
   * that anchor out and records it as a limitation.
   */
  targetPaths?: readonly string[];
}

/**
 * A focused index over selected targets. Relevance is decided before any
 * symlink is rejected: an alias the targets do not need is skipped, a required
 * one is reported, and none is ever followed. A page anchor the index cannot
 * admit stops it on a selected target and is recorded on any other page.
 */
export interface BuildScopedContentIndexInput {
  repositoryPath: string;
  repositoryRevision: string;
  /** Selected repository-relative targets; never empty. */
  includePaths: readonly string[];
  /**
   * Tracked symlink paths that a materialized export leaves absent on disk.
   * Each one is classified exactly as an on-disk symlink at the same path.
   */
  trackedAliasPaths?: readonly string[];
}

/** What a focused index could not cover, by relevance class. Paths are repository-relative. */
export interface ScopedIndexCoverage {
  /** A selected target, or a directory on a target's path, is an alias. Never followed. */
  refusedAliasPaths: string[];
  /**
   * A navigation source on a target's ancestor chain is an alias or an
   * unsupported shape, so the targets' navigation context is incomplete.
   */
  incompleteNavigationPaths: string[];
  /** An optional page beside a target's ancestor chain is an alias; skipped. */
  skippedOptionalAliasPaths: string[];
  /** Navigation entries that name a page outside the focused include set. */
  outOfScopeNavigationTargets: number;
  /**
   * Navigation entries that name a skipped optional alias (a path already in
   * `skippedOptionalAliasPaths`). The alias is never followed, so the chain
   * breaks there exactly as for an out-of-scope entry; it never degrades.
   */
  aliasNavigationTargets: number;
}

export type ScopedContentIndexResult =
  | { status: "indexed"; index: ContentIndexV1; coverage: ScopedIndexCoverage }
  | { status: "alias-refused"; coverage: ScopedIndexCoverage };

export interface BuildContentIndexV2Input {
  /** Host-proven, active export of exactly one immutable tracked Git revision. */
  workspace: import("../repository/workspace/contracts.js").RepositoryWorkspace;
}

export interface BuildContentIndexV3Input extends BuildContentIndexV2Input {}

/**
 * Next action for each page anchor the index refuses. The situation catalog
 * rows for these codes carry the same text; a test holds the two equal.
 */
export const PAGE_ANCHOR_NEXT_ACTIONS = Object.freeze({
  "empty-page-anchor":
    "Edit the line the message names: give the heading, explicit anchor, MyST label, or HTML id a letter or digit, or put a blank line before a --- or === line meant as a thematic break. Commit the change, then rerun the same command.",
  "duplicate-page-anchor":
    "Edit the line the message names: rename the explicit anchor, MyST label, or HTML id so that no other anchor on the page uses it. Commit the change, then rerun the same command.",
} as const);

export type PageAnchorRefusalCode = keyof typeof PAGE_ANCHOR_NEXT_ACTIONS;

/** Run-record warning prefix for a linked asset a workspace index left out past a limit. */
export const CONTENT_INDEX_ASSET_WARNING_CODE = "content-index-asset-left-out";

/**
 * Run-record warning prefix for a file, or a directory, the content index
 * left out under its on-disk name: one an index path cannot hold, or one that
 * is the same as another once Unicode-normalized.
 */
export const CONTENT_INDEX_NAME_WARNING_CODE = "content-index-name-left-out";

/**
 * Run-record warning prefix for a workspace content index the repository
 * inventory could not build, naming the page and the reason (#1932).
 */
export const CONTENT_INDEX_INCOMPLETE_WARNING_CODE = "content-index-incomplete";

export class ContentIndexError extends Error {
  /** Set on page anchor refusals; the operator envelope prefers it to text inferred from the message. */
  public declare readonly nextAction?: string;
  /** The repository path of the page the refusal names, when it names one. */
  public declare readonly sourcePath?: string;

  public constructor(
    public readonly code:
      | "invalid-revision"
      | "unsafe-path"
      | "duplicate-node-identity"
      | PageAnchorRefusalCode
      | "broken-internal-target"
      | "invalid-internal-target"
      | "unsupported-internal-target"
      | "invalid-document-encoding"
      | "source-too-large"
      | "asset-too-large"
      | "asset-count-exceeded"
      | "asset-bytes-exceeded"
      | "tracked-file-changed"
      | "tracked-file-unreadable"
      | "unsupported-document-syntax",
    message: string,
    details?: { readonly sourcePath?: string },
  ) {
    super(message);
    this.name = "ContentIndexError";
    if (Object.hasOwn(PAGE_ANCHOR_NEXT_ACTIONS, code)) {
      this.nextAction = PAGE_ANCHOR_NEXT_ACTIONS[code as PageAnchorRefusalCode];
    }
    if (details?.sourcePath !== undefined) this.sourcePath = details.sourcePath;
  }
}
