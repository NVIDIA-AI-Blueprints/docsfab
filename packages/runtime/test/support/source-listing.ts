// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Reads a `docsfab_list_sources` payload back into inventory rows. The listing
 * names each span's source by handle and carries the long ids, path, and media
 * type once per source; a test that wants a row per span with its ids joins
 * them here, the way a model would.
 */
import type { SourceSpanInventoryEntryV1 } from "../../src/inputs/source-resolver.js";

export interface ListedSourceRow {
  handle: string;
  observationId: string;
  representationId: string;
  repositoryPath: string | null;
  mediaType: string;
  spanCount: number;
  bytes: number;
  diffFiles?: number;
}

export interface ListedSpanRow {
  source: string;
  spanId: string;
  startByte: number;
  endByte: number;
  locator: SourceSpanInventoryEntryV1["locator"];
}

export interface SourceListing {
  kind: "docsfab-source-span-inventory";
  sourceCount: number;
  sources: ListedSourceRow[];
  truncated: boolean;
  spanCount: number;
  spans: ListedSpanRow[];
}

/** A listing's span rows, each with its source's handle, ids, path, and media type. */
export function listedInventory(
  listing: string | SourceListing,
): Array<SourceSpanInventoryEntryV1 & { source: string }> {
  const parsed = typeof listing === "string" ? (JSON.parse(listing) as SourceListing) : listing;
  const sources = new Map(parsed.sources.map((source) => [source.handle, source]));
  return parsed.spans.map((span) => {
    const source = sources.get(span.source);
    if (!source) throw new Error(`The listing names no source ${span.source}.`);
    return {
      source: span.source,
      observationId: source.observationId,
      representationId: source.representationId,
      repositoryPath: source.repositoryPath,
      mediaType: source.mediaType,
      spanId: span.spanId,
      startByte: span.startByte,
      endByte: span.endByte,
      locator: span.locator,
    };
  });
}
