// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Byte-manifest shape and digest helpers for prepared local documentation. */
import type { PreparedLocalSourceRefV1 } from "../live-agent/task-contract.js";
import { canonicalDigest } from "../content-ir/canonical.js";

export const PREPARED_LOCAL_SOURCES_KIND = "docsfab-prepared-local-sources" as const;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export interface PreparedLocalSourceFileMetadataV1 {
  readonly path: string;
  readonly byteLength: number;
  readonly sha256: string;
}

/** Exact bytes returned by the local Git snapshot exporter. */
export interface PreparedLocalSourceFileV1 extends PreparedLocalSourceFileMetadataV1 {
  readonly bytes: Uint8Array;
}

/** Content-minimized manifest entry mounted by a trusted host. */
export interface PreparedLocalSourceManifestEntryV1 {
  readonly ref: PreparedLocalSourceRefV1;
  readonly files: readonly PreparedLocalSourceFileMetadataV1[];
}

/** Serialized manifest; task refs can select entries but contain no filesystem locator. */
export interface PreparedLocalSourceManifestV1 {
  readonly schemaVersion: 1;
  readonly kind: typeof PREPARED_LOCAL_SOURCES_KIND;
  readonly sources: readonly PreparedLocalSourceManifestEntryV1[];
}

/** In-memory result used by a trusted host to materialize a local snapshot. */
export interface PreparedLocalSourceSnapshotV1 {
  readonly ref: PreparedLocalSourceRefV1;
  readonly files: readonly PreparedLocalSourceFileV1[];
}

/** Digest used by both the producer and mounted reader; content bytes stay out of the manifest. */
export function preparedLocalSourceContentSha256(input: {
  readonly sourceId: string;
  readonly repositoryRevision: string;
  readonly files: readonly PreparedLocalSourceFileMetadataV1[];
}): string {
  const files = [...input.files]
    .map(({ path, byteLength, sha256 }) => ({ path, byteLength, sha256 }))
    .sort((left, right) => compareText(left.path, right.path));
  return canonicalDigest({
    schemaVersion: 1 as const,
    kind: "docsfab-prepared-local-source" as const,
    sourceId: input.sourceId,
    repositoryRevision: input.repositoryRevision,
    files,
  });
}

export function preparedLocalSourceManifestEntry(
  snapshot: PreparedLocalSourceSnapshotV1,
): PreparedLocalSourceManifestEntryV1 {
  return Object.freeze({
    ref: snapshot.ref,
    files: Object.freeze(
      snapshot.files
        .map(({ path, byteLength, sha256 }) => Object.freeze({ path, byteLength, sha256 }))
        .sort((left, right) => compareText(left.path, right.path)),
    ),
  });
}

export function createPreparedLocalSourceManifest(
  snapshots: readonly PreparedLocalSourceSnapshotV1[],
): PreparedLocalSourceManifestV1 {
  const sources = snapshots
    .map(preparedLocalSourceManifestEntry)
    .sort((left, right) => compareText(left.ref.sourceId, right.ref.sourceId));
  return Object.freeze({
    schemaVersion: 1,
    kind: PREPARED_LOCAL_SOURCES_KIND,
    sources: Object.freeze(sources),
  });
}
