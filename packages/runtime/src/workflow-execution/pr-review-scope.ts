// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { canonicalDigest } from "../contract-kit/index.js";
import type { RunReviewScope } from "../execution/contracts.js";
import type { GithubPrBaseDocumentationDescriptor } from "../inputs/adapters/github-pr-provider.js";
import { assertGithubPrBaseDocumentationDescriptor } from "../inputs/adapters/github-pr-provider.js";
import type { GithubPrManifestRow } from "../inputs/adapters/github-pr-objects.js";
import type { RepositoryDiscoveryInventoryV1 } from "../repository/inventory.js";
import { publicDocumentationPaths } from "./local-review-scope.js";

export interface PrReviewScopeProjectionV1 {
  readonly schemaVersion: 1;
  readonly kind: "docsfab-pr-review-scope";
  readonly scope: RunReviewScope;
  readonly changedDocumentationPaths: readonly string[];
  readonly deletedDocumentationPaths: readonly string[];
  readonly impact: "changed-documentation" | "documentation-set-uncertain";
  readonly limitations: readonly string[];
  readonly baseDocumentationDescriptorSha256: string;
  readonly projectionSha256: string;
}

const isDoc = (path: string | null): path is string => path !== null && /\.mdx?$/iu.test(path);

/** Derive review radius from authenticated M..H changes, H inventory and B context. */
export function projectPrReviewScope(input: {
  readonly manifest: readonly GithubPrManifestRow[];
  readonly headInventory: RepositoryDiscoveryInventoryV1;
  readonly baseDocumentation: GithubPrBaseDocumentationDescriptor;
}): PrReviewScopeProjectionV1 {
  assertGithubPrBaseDocumentationDescriptor(input.baseDocumentation);
  const inventory = input.headInventory;
  if (inventory.repositoryRevision === "") {
    throw new Error("GitHub PR review requires an authenticated H inventory revision.");
  }
  const inventoryComplete =
    inventory.status === "complete" &&
    inventory.coverage.structure.status === "complete" &&
    inventory.coverage.text.status === "complete";
  const allDocs = publicDocumentationPaths(inventory).filter(isDoc);
  const available = new Set(allDocs);
  const changed = [
    ...new Set(
      input.manifest
        .map((row) => row.newPath)
        .filter(isDoc)
        .filter((path) => available.has(path)),
    ),
  ].sort();
  const deleted = [
    ...new Set(
      input.manifest
        .map((row) => row.oldPath)
        .filter(isDoc)
        .filter((path) => !available.has(path)),
    ),
  ].sort();
  const otherChanges = input.manifest.some(
    (row) => row.content !== "regular" || !isDoc(row.newPath) || row.status.startsWith("D"),
  );
  const focused = inventoryComplete && !otherChanges && changed.length > 0;
  const targetPaths = focused ? changed : allDocs;
  const limitations = [
    ...(deleted.length
      ? ["Deleted documentation needs M-before evidence and surviving-reference checks."]
      : []),
    ...(!inventoryComplete
      ? [
          "H documentation inventory is incomplete; reviewed pages are an observed subset and omitted impact remains unknown.",
        ]
      : []),
    ...(!focused
      ? [
          "Non-documentation, deleted, or uncertain changes require documentation-set impact review; no no-impact conclusion is implied.",
        ]
      : []),
    ...(allDocs.length === 0
      ? [
          "No surviving public Markdown/MDX pages were inventoried; documentation impact is unresolved.",
        ]
      : []),
  ];
  const scopeBody = {
    scope: "focused-set" as const,
    reason: focused ? ("within-budget" as const) : ("scan-unavailable" as const),
    targetPaths,
    deferredPaths: [] as readonly string[],
    corpusFileCount: allDocs.length,
  };
  const scope = { ...scopeBody, scopeSha256: canonicalDigest(scopeBody) };
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-pr-review-scope" as const,
    scope,
    changedDocumentationPaths: changed,
    deletedDocumentationPaths: deleted,
    impact: focused ? ("changed-documentation" as const) : ("documentation-set-uncertain" as const),
    limitations,
    baseDocumentationDescriptorSha256: input.baseDocumentation.descriptorSha256,
  };
  return { ...body, projectionSha256: canonicalDigest(body) };
}
