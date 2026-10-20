// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { canonicalDigest } from "../contract-kit/index.js";
import {
  assertGithubPrReviewBasis,
  type GithubPrReviewBasis,
} from "./adapters/github-pr-provider.js";
import type { ChangeRequestRefV1 } from "./change-request.js";
import { isGitFullObjectId } from "./change-source/revision.js";

export interface PrReviewBasisBindingV1 {
  readonly schemaVersion: 1;
  readonly kind: "docsfab-pr-review-basis-binding";
  readonly ref: ChangeRequestRefV1;
  readonly targetRepositoryId: string;
  readonly headRepositoryId: string;
  readonly B: string;
  readonly H: string;
  readonly M: string;
  readonly baseTree: string;
  readonly headTree: string;
  readonly manifestSha256: string;
  readonly headEntriesSha256: string;
  readonly baseDocumentationDescriptorSha256: string;
  readonly basisSha256: string;
}

/** Host-only projection of the live callback basis; this value grants no source read. */
export function bindPrReviewBasis(basis: GithubPrReviewBasis): PrReviewBasisBindingV1 {
  assertGithubPrReviewBasis(basis);
  const { acquisition, headWorkspace, baseDocumentation } = basis;
  if (
    acquisition.ref.targetRepositoryId !== String(baseDocumentation.targetRepositoryId) ||
    acquisition.graph.H !== headWorkspace.revision ||
    acquisition.graph.B !== baseDocumentation.B ||
    headWorkspace.manifestSha256 !== canonicalDigest(acquisition.manifest)
  ) {
    throw new Error("The PR review basis source, inventory, and workspace disagree.");
  }
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-pr-review-basis-binding" as const,
    ref: acquisition.ref,
    targetRepositoryId: acquisition.ref.targetRepositoryId,
    headRepositoryId: String(acquisition.headRepositoryId),
    B: acquisition.graph.B,
    H: acquisition.graph.H,
    M: acquisition.graph.M,
    baseTree: acquisition.graph.baseTree,
    headTree: acquisition.graph.headTree,
    manifestSha256: headWorkspace.manifestSha256,
    headEntriesSha256: headWorkspace.headEntriesSha256,
    baseDocumentationDescriptorSha256: baseDocumentation.descriptorSha256,
  };
  return { ...body, basisSha256: canonicalDigest(body) };
}

/** Saved provenance is data only; decoding never restores callback authority. */
export function decodePrReviewBasisBinding(value: unknown): PrReviewBasisBindingV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The saved PR review basis is malformed and cannot be trusted.");
  }
  const root = value as Record<string, unknown>;
  const keys = [
    "schemaVersion",
    "kind",
    "ref",
    "targetRepositoryId",
    "headRepositoryId",
    "B",
    "H",
    "M",
    "baseTree",
    "headTree",
    "manifestSha256",
    "headEntriesSha256",
    "baseDocumentationDescriptorSha256",
    "basisSha256",
  ];
  if (
    Object.keys(root).sort().join("\0") !== keys.sort().join("\0") ||
    root.schemaVersion !== 1 ||
    root.kind !== "docsfab-pr-review-basis-binding" ||
    !root.ref ||
    typeof root.ref !== "object" ||
    (root.ref as ChangeRequestRefV1).provider !== "github" ||
    (root.ref as ChangeRequestRefV1).objectKind !== "pull-request" ||
    !["B", "H", "M", "baseTree", "headTree"].every(
      (key) => typeof root[key] === "string" && isGitFullObjectId(root[key] as string),
    ) ||
    ![
      "manifestSha256",
      "headEntriesSha256",
      "baseDocumentationDescriptorSha256",
      "basisSha256",
    ].every(
      (key) => typeof root[key] === "string" && /^[a-f0-9]{64}$/u.test(root[key] as string),
    ) ||
    !["targetRepositoryId", "headRepositoryId"].every(
      (key) => typeof root[key] === "string" && /^[1-9][0-9]*$/u.test(root[key] as string),
    ) ||
    (root.ref as ChangeRequestRefV1).targetRepositoryId !== root.targetRepositoryId ||
    root.basisSha256 !==
      canonicalDigest(
        Object.fromEntries(Object.entries(root).filter(([key]) => key !== "basisSha256")),
      )
  ) {
    throw new Error("The saved PR review basis is malformed or differs from its digest.");
  }
  return root as unknown as PrReviewBasisBindingV1;
}
