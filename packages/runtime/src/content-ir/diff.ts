// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ContentIndexV1,
  ContentIndexV2,
  ContentIndexV3,
  DocumentNode,
  DocumentNodeV3,
  StructuralChangeRegion,
  StructuralDiff,
  StructuralDiffV2,
  StructuralDiffV3,
} from "./contracts.js";
import { decodeContentIndex } from "./decoder.js";

const REGION_ORDER: StructuralChangeRegion[] = [
  "body",
  "headings",
  "metadata",
  "navigation",
  "graph",
];

export function diffContentIndexes(before: ContentIndexV1, after: ContentIndexV1): StructuralDiff {
  const beforeDocuments = documentMap(before);
  const afterDocuments = documentMap(after);
  const documentIds = [...new Set([...beforeDocuments.keys(), ...afterDocuments.keys()])].sort();
  const documents = documentIds.flatMap((documentId) => {
    const left = beforeDocuments.get(documentId);
    const right = afterDocuments.get(documentId);
    if (!left || !right) {
      const document = left ?? right!;
      return [
        {
          documentId,
          sourcePath: document.sourcePath,
          regions: [...REGION_ORDER],
        },
      ];
    }
    const moved = left.sourcePath !== right.sourcePath;
    const regions = REGION_ORDER.filter(
      (region) =>
        left.regions[region] !== right.regions[region] ||
        (moved && (region === "navigation" || region === "graph")),
    );
    return regions.length === 0
      ? []
      : [
          {
            documentId,
            sourcePath: right.sourcePath,
            ...(moved ? { previousSourcePath: left.sourcePath } : {}),
            regions,
          },
        ];
  });
  const regions = REGION_ORDER.filter((region) =>
    documents.some((document) => document.regions.includes(region)),
  );
  return {
    schemaVersion: 1,
    fromRevision: before.repository.revision,
    toRevision: after.repository.revision,
    fromIndexDigest: before.indexDigest,
    toIndexDigest: after.indexDigest,
    regions,
    documents,
  };
}

export function diffContentIndexesV2(
  before: ContentIndexV2,
  after: ContentIndexV2,
): StructuralDiffV2 {
  const diff = diffDocuments(before, after);
  return { schemaVersion: 2, ...diff };
}

/**
 * Decodes each historical representation under its own closed schema before
 * comparison. The result version is the newest input version, so an RST-aware
 * comparison always carries the V3 digest contract.
 */
export function diffContentIndexesVersioned(
  beforeValue: unknown,
  afterValue: unknown,
): StructuralDiff | StructuralDiffV2 | StructuralDiffV3 {
  const before = decodeContentIndex(beforeValue);
  const after = decodeContentIndex(afterValue);
  const diff = diffDocuments(before, after);
  if (before.schemaVersion === 3 || after.schemaVersion === 3) {
    return { schemaVersion: 3, ...diff };
  }
  if (before.schemaVersion === 2 || after.schemaVersion === 2) {
    return { schemaVersion: 2, ...diff };
  }
  return { schemaVersion: 1, ...diff };
}

function diffDocuments(
  before: ContentIndexV1 | ContentIndexV2 | ContentIndexV3,
  after: ContentIndexV1 | ContentIndexV2 | ContentIndexV3,
): Omit<StructuralDiff, "schemaVersion"> {
  const beforeDocuments = documentMap(before);
  const afterDocuments = documentMap(after);
  const documentIds = [...new Set([...beforeDocuments.keys(), ...afterDocuments.keys()])].sort();
  const documents = documentIds.flatMap((documentId) => {
    const left = beforeDocuments.get(documentId);
    const right = afterDocuments.get(documentId);
    if (!left || !right) {
      const document = left ?? right!;
      return [{ documentId, sourcePath: document.sourcePath, regions: [...REGION_ORDER] }];
    }
    const moved = left.sourcePath !== right.sourcePath;
    const regions = REGION_ORDER.filter(
      (region) =>
        left.regions[region] !== right.regions[region] ||
        (moved && (region === "navigation" || region === "graph")),
    );
    return regions.length === 0
      ? []
      : [
          {
            documentId,
            sourcePath: right.sourcePath,
            ...(moved ? { previousSourcePath: left.sourcePath } : {}),
            regions,
          },
        ];
  });
  const regions = REGION_ORDER.filter((region) =>
    documents.some((document) => document.regions.includes(region)),
  );
  return {
    fromRevision: before.repository.revision,
    toRevision: after.repository.revision,
    fromIndexDigest: before.indexDigest,
    toIndexDigest: after.indexDigest,
    regions,
    documents,
  };
}

function documentMap(
  index: ContentIndexV1 | ContentIndexV2 | ContentIndexV3,
): Map<string, DocumentNode | DocumentNodeV3> {
  return new Map(
    index.nodes
      .filter((node): node is DocumentNode | DocumentNodeV3 => node.kind === "document")
      .map((node) => [node.id, node] as [string, DocumentNode | DocumentNodeV3]),
  );
}
