// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  ArtifactStoreError,
  isArtifactObjectSizeRefusal,
  opaqueRecordDigest,
  type DurableArtifactStore,
} from "../../artifacts/index.js";
import { decodeContentIndexV1 } from "../../content-ir/index.js";
import type { ContentIndexV1 } from "../../content-ir/contracts.js";
import { fail, kit } from "./contract-kit.js";
import { recordLocator } from "./record-locators.js";

const CONTENT_INDEX_PART_KIND = "docsfab-editorial-content-index-part";
const CONTENT_INDEX_PARTS_KIND = "docsfab-editorial-content-index-parts";
const CONTENT_INDEX_PARTS_KEYS = [
  "schemaVersion",
  "kind",
  "indexSchemaVersion",
  "indexDigest",
  "repository",
  "evidence",
  "parts",
] as const;

interface ContentIndexPartV1 {
  schemaVersion: 1;
  kind: typeof CONTENT_INDEX_PART_KIND;
  nodes: ContentIndexV1["nodes"];
  edges: ContentIndexV1["edges"];
}

/**
 * Store the content index whole when it fits the store's object bound, and
 * otherwise as content-addressed parts listed by a manifest, so the size of a
 * repository alone never stops a run at that bound. The manifest has its own
 * locator: a store that already holds the whole record keeps it unchanged.
 */
export async function persistContentIndex(
  store: DurableArtifactStore,
  index: ContentIndexV1,
): Promise<void> {
  try {
    await store.putRecord(recordLocator("content-index", index.indexDigest), index);
    return;
  } catch (error) {
    // The size check runs before anything is written, so no partial object remains.
    if (!isArtifactObjectSizeRefusal(error)) throw error;
  }
  // Where the parts split depends on the bound in force when they were written,
  // so a store shared by runs under another bound may already hold a different,
  // equally valid split of this index. Reuse it once it verifies in full.
  if (await hasVerifiedContentIndexParts(store, index.indexDigest)) return;
  const parts: { digest: string; nodes: number; edges: number }[] = [];
  for (const part of splitContentIndex(index, store.maxObjectBytes)) {
    const digest = opaqueRecordDigest(part);
    await store.putRecord(digest, part);
    parts.push({ digest, nodes: part.nodes.length, edges: part.edges.length });
  }
  await store.putRecord(recordLocator("content-index-parts", index.indexDigest), {
    schemaVersion: 1,
    kind: CONTENT_INDEX_PARTS_KIND,
    indexSchemaVersion: index.schemaVersion,
    indexDigest: index.indexDigest,
    repository: index.repository,
    evidence: index.evidence,
    parts,
  });
}

/**
 * Whether the store already holds a parts manifest for `indexDigest` whose
 * parts all verify and recompute that digest. A manifest that fails to verify,
 * including one whose parts exceed the bound now in force, refuses with its
 * own code rather than being written over.
 */
async function hasVerifiedContentIndexParts(
  store: DurableArtifactStore,
  indexDigest: string,
): Promise<boolean> {
  try {
    await store.getRecord(recordLocator("content-index-parts", indexDigest));
  } catch (error) {
    if (error instanceof ArtifactStoreError && error.code === "not-found") return false;
    throw error;
  }
  await loadContentIndex(store, indexDigest);
  return true;
}

/**
 * Split nodes, then edges, in index order into parts whose stored JSON stays
 * within `maximumBytes`. An item larger than that alone gets its own part, and
 * the store then refuses that part by its own bound and size.
 */
function splitContentIndex(index: ContentIndexV1, maximumBytes: number): ContentIndexPartV1[] {
  const emptyPart = (): ContentIndexPartV1 => ({
    schemaVersion: 1,
    kind: CONTENT_INDEX_PART_KIND,
    nodes: [],
    edges: [],
  });
  const envelopeBytes = Buffer.byteLength(JSON.stringify(emptyPart()));
  const parts: ContentIndexPartV1[] = [];
  let current = emptyPart();
  let currentBytes = envelopeBytes;
  const add = <K extends "nodes" | "edges">(field: K, item: ContentIndexPartV1[K][number]) => {
    // Sorted-key JSON has the same length as JSON.stringify of the same value.
    const itemBytes = Buffer.byteLength(JSON.stringify(item));
    const separator = current[field].length > 0 ? 1 : 0;
    if (
      currentBytes + separator + itemBytes > maximumBytes &&
      current.nodes.length + current.edges.length > 0
    ) {
      parts.push(current);
      current = emptyPart();
      currentBytes = envelopeBytes;
    }
    currentBytes += (current[field].length > 0 ? 1 : 0) + itemBytes;
    (current[field] as ContentIndexPartV1[K][number][]).push(item);
  };
  for (const node of index.nodes) add("nodes", node);
  for (const edge of index.edges) add("edges", edge);
  if (parts.length === 0 || current.nodes.length + current.edges.length > 0) parts.push(current);
  return parts;
}

/**
 * Load the content index bound to `indexDigest`, stored whole or in parts.
 * Every part must hash to its listed digest, and the reassembled index must
 * recompute to `indexDigest`, so a substituted or reordered part fails closed.
 */
export async function loadContentIndex(
  store: DurableArtifactStore,
  indexDigest: string,
): Promise<ContentIndexV1> {
  let manifestValue: unknown;
  try {
    manifestValue = await store.getRecord(recordLocator("content-index-parts", indexDigest));
  } catch (error) {
    if (!(error instanceof ArtifactStoreError && error.code === "not-found")) throw error;
    return boundContentIndex(
      await store.getRecord(recordLocator("content-index", indexDigest)),
      indexDigest,
    );
  }
  const manifest = kit.object(manifestValue);
  kit.exact(manifest, CONTENT_INDEX_PARTS_KEYS);
  if (
    manifest.schemaVersion !== 1 ||
    manifest.kind !== CONTENT_INDEX_PARTS_KIND ||
    manifest.indexSchemaVersion !== 1
  ) {
    fail("invalid-shape");
  }
  if (kit.hash(manifest.indexDigest) !== indexDigest) fail("identity-mismatch");
  const entries = kit.array(manifest.parts);
  if (entries.length < 1) fail("invalid-shape");
  const nodes: unknown[] = [];
  const edges: unknown[] = [];
  for (const entryValue of entries) {
    const entry = kit.object(entryValue);
    kit.exact(entry, ["digest", "nodes", "edges"]);
    const digest = kit.hash(entry.digest);
    const nodeCount = partItemCount(entry.nodes);
    const edgeCount = partItemCount(entry.edges);
    const partValue = await store.getRecord(digest);
    if (opaqueRecordDigest(partValue) !== digest) fail("identity-mismatch");
    const part = kit.object(partValue);
    kit.exact(part, ["schemaVersion", "kind", "nodes", "edges"]);
    if (part.schemaVersion !== 1 || part.kind !== CONTENT_INDEX_PART_KIND) fail("invalid-shape");
    const partNodes = kit.array(part.nodes);
    const partEdges = kit.array(part.edges);
    if (partNodes.length !== nodeCount || partEdges.length !== edgeCount) {
      fail("identity-mismatch");
    }
    // A loop, not a spread: a part can hold more items than a call has arguments.
    for (const node of partNodes) nodes.push(node);
    for (const edge of partEdges) edges.push(edge);
  }
  return boundContentIndex(
    {
      schemaVersion: 1,
      repository: manifest.repository,
      indexDigest,
      nodes,
      edges,
      evidence: manifest.evidence,
    },
    indexDigest,
  );
}

function partItemCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail("invalid-value");
  }
  return value;
}

function boundContentIndex(value: unknown, indexDigest: string): ContentIndexV1 {
  const index = decodeContentIndexV1(value);
  if (index.indexDigest !== indexDigest) fail("identity-mismatch");
  return index;
}
