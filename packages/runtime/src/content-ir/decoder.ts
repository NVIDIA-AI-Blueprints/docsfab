// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isAbsolute, posix } from "node:path";

import { canonicalDigest } from "./canonical.js";
import type {
  AssetStructuralEdge,
  ContentIndex,
  ContentIndexKnown,
  ContentIndexV1,
  ContentIndexV2,
  ContentIndexV3,
  ContentNode,
  StructuralEdge,
  StructuralEdgeV2,
} from "./contracts.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const NODE_EDGE_KINDS = new Set([
  "parent",
  "child",
  "previous-sibling",
  "next-sibling",
  "outbound-link",
  "backlink",
  "navigation",
]);
const FORMATS_V1_V2 = new Set(["markdown", "gfm", "myst", "mdx"]);
const FORMATS_V3 = new Set([...FORMATS_V1_V2, "rst"]);
const FIELD_TYPES = new Set(["string", "number", "boolean", "null", "sequence", "mapping"]);

export class ContentIndexDecodeError extends Error {
  public constructor(
    public readonly code: "invalid-shape" | "unknown-field" | "invalid-binding",
    public readonly path: string,
  ) {
    super(`${code} at ${path}`);
    this.name = "ContentIndexDecodeError";
  }
}

type JsonObject = Record<string, unknown>;

export function decodeContentIndex(value: unknown): ContentIndexKnown {
  const root = object(value, "$", [
    "schemaVersion",
    "repository",
    "indexDigest",
    "nodes",
    "edges",
    "evidence",
  ]);
  if (root.schemaVersion === 1) return decodeContentIndexV1(value);
  if (root.schemaVersion === 2) return decodeContentIndexV2(value);
  if (root.schemaVersion === 3) return decodeContentIndexV3(value);
  fail("invalid-shape", "$.schemaVersion");
}

export function decodeContentIndexV1(value: unknown): ContentIndexV1 {
  const root = indexRoot(value, 1);
  const repository = repositoryIdentity(root.repository);
  const nodes = nodesValue(root.nodes);
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = array(root.edges, "$.edges").map((edge, index) =>
    nodeEdge(edge, `$.edges[${index}]`, nodeIds),
  );
  const evidence = evidenceValue(root.evidence, 1);
  validateBinding(repository, root.indexDigest, nodes, edges, evidence, 1);
  return value as ContentIndexV1;
}

export function decodeContentIndexV2(value: unknown): ContentIndexV2 {
  const root = indexRoot(value, 2);
  const repository = repositoryIdentity(root.repository);
  const nodes = nodesValue(root.nodes);
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = array(root.edges, "$.edges").map((edge, index) =>
    edgeV2(edge, `$.edges[${index}]`, nodeIds, repository.revision),
  );
  if (
    new Set(edges.map((edge) => `${edge.kind}\0${edge.from}\0${edge.to}`)).size !== edges.length
  ) {
    fail("invalid-binding", "$.edges");
  }
  const evidence = evidenceValue(root.evidence, 2);
  validateBinding(repository, root.indexDigest, nodes, edges, evidence, 2);
  const assetCount = new Set(
    edges
      .filter((edge): edge is AssetStructuralEdge => edge.kind === "asset-link")
      .map((edge) => edge.target.sourcePath),
  ).size;
  if (evidence.assetCount !== assetCount) fail("invalid-binding", "$.evidence.assetCount");
  const assetBindings = new Map<string, string>();
  for (const edge of edges) {
    if (edge.kind !== "asset-link") continue;
    const binding = canonicalDigest(edge.target);
    const previous = assetBindings.get(edge.target.sourcePath);
    if (previous && previous !== binding) fail("invalid-binding", "$.edges");
    assetBindings.set(edge.target.sourcePath, binding);
  }
  return value as ContentIndexV2;
}

export function decodeContentIndexV3(value: unknown): ContentIndexV3 {
  const root = indexRoot(value, 3);
  const repository = repositoryIdentity(root.repository);
  const nodes = nodesValue(root.nodes, 3);
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = array(root.edges, "$.edges").map((edge, index) =>
    edgeV2(edge, `$.edges[${index}]`, nodeIds, repository.revision),
  );
  if (
    new Set(edges.map((edge) => `${edge.kind}\0${edge.from}\0${edge.to}`)).size !== edges.length
  ) {
    fail("invalid-binding", "$.edges");
  }
  const evidence = evidenceValue(root.evidence, 3);
  validateBinding(repository, root.indexDigest, nodes, edges, evidence, 3);
  const assetCount = new Set(
    edges
      .filter((edge): edge is AssetStructuralEdge => edge.kind === "asset-link")
      .map((edge) => edge.target.sourcePath),
  ).size;
  if (evidence.assetCount !== assetCount) fail("invalid-binding", "$.evidence.assetCount");
  const assetBindings = new Map<string, string>();
  for (const edge of edges) {
    if (edge.kind !== "asset-link") continue;
    const binding = canonicalDigest(edge.target);
    const previous = assetBindings.get(edge.target.sourcePath);
    if (previous && previous !== binding) fail("invalid-binding", "$.edges");
    assetBindings.set(edge.target.sourcePath, binding);
  }
  return value as ContentIndexV3;
}

export function migrateContentIndexV1ToV2(value: unknown): ContentIndexV2 {
  const v1 = decodeContentIndexV1(value);
  const repository = structuredClone(v1.repository);
  const nodes = structuredClone(v1.nodes);
  const edges = structuredClone(v1.edges);
  const indexDigest = canonicalDigest({ schemaVersion: 2, repository, nodes, edges });
  return decodeContentIndexV2({
    schemaVersion: 2,
    repository,
    indexDigest,
    nodes,
    edges,
    evidence: {
      ...structuredClone(v1.evidence),
      indexDigest,
      assetCount: 0,
    },
  });
}

function indexRoot(value: unknown, version: 1 | 2 | 3): JsonObject {
  const root = object(value, "$", [
    "schemaVersion",
    "repository",
    "indexDigest",
    "nodes",
    "edges",
    "evidence",
  ]);
  if (root.schemaVersion !== version) fail("invalid-shape", "$.schemaVersion");
  return root;
}

function repositoryIdentity(value: unknown): { revision: string; contentDigest: string } {
  const item = object(value, "$.repository", ["revision", "contentDigest"]);
  const revision = text(item.revision, "$.repository.revision");
  const contentDigest = text(item.contentDigest, "$.repository.contentDigest");
  if (!REVISION.test(revision)) fail("invalid-shape", "$.repository.revision");
  if (!SHA256.test(contentDigest)) fail("invalid-shape", "$.repository.contentDigest");
  return { revision, contentDigest };
}

function nodesValue(value: unknown, version: 1 | 2 | 3 = 2): ContentNode[] {
  const nodes = array(value, "$.nodes").map((node, index) =>
    nodeValue(node, `$.nodes[${index}]`, version),
  );
  if (new Set(nodes.map((node) => node.id)).size !== nodes.length)
    fail("invalid-binding", "$.nodes");
  return nodes;
}

function nodeValue(value: unknown, path: string, version: 1 | 2 | 3): ContentNode {
  const candidate = objectAny(value, path);
  if (candidate.kind === "document") {
    const item = object(value, path, [
      "id",
      "kind",
      "sourcePath",
      "format",
      "byteLength",
      "anchors",
      "frontmatter",
      "directives",
      "codeBlocks",
      "regions",
    ]);
    const format = text(item.format, `${path}.format`);
    if (!(version === 3 ? FORMATS_V3 : FORMATS_V1_V2).has(format)) {
      fail("invalid-shape", `${path}.format`);
    }
    const regions = object(item.regions, `${path}.regions`, [
      "body",
      "headings",
      "metadata",
      "navigation",
      "graph",
    ]);
    for (const name of Object.keys(regions)) hash(regions[name], `${path}.regions.${name}`);
    array(item.anchors, `${path}.anchors`).forEach((anchor, index) =>
      text(anchor, `${path}.anchors[${index}]`),
    );
    array(item.frontmatter, `${path}.frontmatter`).forEach((field, index) => {
      const child = object(field, `${path}.frontmatter[${index}]`, ["name", "type"]);
      text(child.name, `${path}.frontmatter[${index}].name`);
      if (!FIELD_TYPES.has(text(child.type, `${path}.frontmatter[${index}].type`))) {
        fail("invalid-shape", `${path}.frontmatter[${index}].type`);
      }
    });
    array(item.directives, `${path}.directives`).forEach((directive, index) => {
      const child = object(directive, `${path}.directives[${index}]`, ["name", "line"]);
      text(child.name, `${path}.directives[${index}].name`);
      integer(child.line, `${path}.directives[${index}].line`, 1);
    });
    array(item.codeBlocks, `${path}.codeBlocks`).forEach((block, index) => {
      const child = object(
        block,
        `${path}.codeBlocks[${index}]`,
        ["language", "startLine", "endLine"],
        ["startLine", "endLine"],
      );
      if (child.language !== undefined)
        text(child.language, `${path}.codeBlocks[${index}].language`);
      integer(child.startLine, `${path}.codeBlocks[${index}].startLine`, 1);
      integer(child.endLine, `${path}.codeBlocks[${index}].endLine`, 1);
    });
    commonNode(item, path);
    integer(item.byteLength, `${path}.byteLength`, 0);
    return value as ContentNode;
  }
  if (candidate.kind === "section") {
    const item = object(value, path, [
      "id",
      "kind",
      "documentId",
      "sourcePath",
      "anchor",
      "depth",
      "startLine",
      "endLine",
    ]);
    commonNode(item, path);
    text(item.documentId, `${path}.documentId`);
    text(item.anchor, `${path}.anchor`);
    integer(item.depth, `${path}.depth`, 1);
    integer(item.startLine, `${path}.startLine`, 1);
    integer(item.endLine, `${path}.endLine`, 1);
    return value as ContentNode;
  }
  fail("invalid-shape", `${path}.kind`);
}

function commonNode(item: JsonObject, path: string): void {
  text(item.id, `${path}.id`);
  safePath(item.sourcePath, `${path}.sourcePath`);
}

function nodeEdge(value: unknown, path: string, nodeIds: ReadonlySet<string>): StructuralEdge {
  const item = object(value, path, ["kind", "from", "to"]);
  const kind = text(item.kind, `${path}.kind`);
  const from = text(item.from, `${path}.from`);
  const to = text(item.to, `${path}.to`);
  if (
    !NODE_EDGE_KINDS.has(kind) ||
    !nodeIds.has(from) ||
    (!nodeIds.has(to) && !(kind === "outbound-link" && /^external:[a-f0-9]{64}$/u.test(to)))
  ) {
    fail("invalid-binding", path);
  }
  return value as StructuralEdge;
}

function edgeV2(
  value: unknown,
  path: string,
  nodeIds: ReadonlySet<string>,
  revision: string,
): StructuralEdgeV2 {
  const candidate = objectAny(value, path);
  if (candidate.kind !== "asset-link") return nodeEdge(value, path, nodeIds);
  const item = object(value, path, ["kind", "from", "to", "target"]);
  const from = text(item.from, `${path}.from`);
  const to = text(item.to, `${path}.to`);
  const target = object(item.target, `${path}.target`, [
    "kind",
    "sourcePath",
    "repositoryRevision",
    "digest",
  ]);
  if (target.kind !== "asset" || !nodeIds.has(from)) fail("invalid-binding", path);
  const sourcePath = safePath(target.sourcePath, `${path}.target.sourcePath`);
  if (target.repositoryRevision !== revision)
    fail("invalid-binding", `${path}.target.repositoryRevision`);
  hash(target.digest, `${path}.target.digest`);
  if (to !== `asset:${canonicalDigest(sourcePath)}`) fail("invalid-binding", `${path}.to`);
  return value as AssetStructuralEdge;
}

function evidenceValue(value: unknown, version: 1 | 2 | 3): JsonObject {
  const keys = [
    "repositoryRevision",
    "contentDigest",
    "indexDigest",
    "documentCount",
    "sectionCount",
    "edgeCount",
  ];
  if (version >= 2) keys.push("assetCount");
  const item = object(value, "$.evidence", keys);
  if (!REVISION.test(text(item.repositoryRevision, "$.evidence.repositoryRevision")))
    fail("invalid-shape", "$.evidence.repositoryRevision");
  hash(item.contentDigest, "$.evidence.contentDigest");
  hash(item.indexDigest, "$.evidence.indexDigest");
  for (const key of [
    "documentCount",
    "sectionCount",
    "edgeCount",
    ...(version >= 2 ? ["assetCount"] : []),
  ]) {
    integer(item[key], `$.evidence.${key}`, 0);
  }
  return item;
}

function validateBinding(
  repository: { revision: string; contentDigest: string },
  digestValue: unknown,
  nodes: ContentNode[],
  edges: StructuralEdgeV2[],
  evidence: JsonObject,
  version: 1 | 2 | 3,
): void {
  const indexDigest = hash(digestValue, "$.indexDigest");
  if (
    evidence.repositoryRevision !== repository.revision ||
    evidence.contentDigest !== repository.contentDigest ||
    evidence.indexDigest !== indexDigest ||
    evidence.documentCount !== nodes.filter((node) => node.kind === "document").length ||
    evidence.sectionCount !== nodes.filter((node) => node.kind === "section").length ||
    evidence.edgeCount !== edges.length ||
    canonicalDigest({ schemaVersion: version, repository, nodes, edges }) !== indexDigest
  ) {
    fail("invalid-binding", "$");
  }
}

function object(
  value: unknown,
  path: string,
  allowed: readonly string[],
  required: readonly string[] = allowed,
): JsonObject {
  const item = objectAny(value, path);
  for (const key of Object.keys(item))
    if (!allowed.includes(key)) fail("unknown-field", `${path}.${key}`);
  for (const key of required)
    if (!Object.hasOwn(item, key)) fail("invalid-shape", `${path}.${key}`);
  return item;
}

function objectAny(value: unknown, path: string): JsonObject {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    fail("invalid-shape", path);
  }
  return value as JsonObject;
}

function array(value: unknown, path: string): unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.getOwnPropertyNames(value).length !== value.length + 1
  ) {
    fail("invalid-shape", path);
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) fail("invalid-shape", `${path}[${index}]`);
  }
  return value;
}

function text(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.normalize("NFC") ||
    /[\0-\x1f\x7f]/u.test(value)
  ) {
    fail("invalid-shape", path);
  }
  return value;
}

function safePath(value: unknown, path: string): string {
  const result = text(value, path);
  if (
    isAbsolute(result) ||
    result.includes("\\") ||
    posix.normalize(result) !== result ||
    result.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    fail("invalid-shape", path);
  }
  return result;
}

function hash(value: unknown, path: string): string {
  const result = text(value, path);
  if (!SHA256.test(result)) fail("invalid-shape", path);
  return result;
}

function integer(value: unknown, path: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum)
    fail("invalid-shape", path);
  return value;
}

function fail(code: ContentIndexDecodeError["code"], path: string): never {
  throw new ContentIndexDecodeError(code, path);
}
