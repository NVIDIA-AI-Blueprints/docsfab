// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { canonicalDigest } from "../contract-kit/index.js";
import type { RunRecord } from "../records/contracts.js";

/** Validate a saved, operator-named review scope before using it as authority. */
export function retainedOperatorReviewTargets(record: RunRecord): readonly string[] | undefined {
  const scope = record.reviewScope;
  if (!scope || scope.scope !== "focused-set" || scope.reason !== "operator-named")
    return undefined;
  const { scopeSha256, ...identity } = scope;
  if (canonicalDigest(identity) !== scopeSha256) return undefined;
  if (
    !Array.isArray(scope.targetPaths) ||
    scope.targetPaths.length === 0 ||
    scope.targetPaths.some(
      (path) =>
        typeof path !== "string" ||
        path !== path.normalize("NFC") ||
        /[\u0000-\u001f\u007f\\]/u.test(path) ||
        path.startsWith("/") ||
        path.split("/").some((part) => !part || part === "." || part === ".."),
    ) ||
    !Array.isArray(scope.deferredPaths) ||
    scope.deferredPaths.length > 0
  )
    return undefined;
  return scope.targetPaths;
}

/** A new review batch can narrow only the original admitted target set. */
export function admitReviewRescope(input: {
  readonly source: RunRecord;
  readonly repositoryPath: string;
  readonly revision: string;
  readonly instruction?: string;
  readonly targetPaths: readonly string[];
  /** Rebuilt from the saved revision only when that run covered the whole set. */
  readonly wholeSetPaths?: readonly string[];
}): { readonly targetPaths: readonly string[]; readonly remainingPaths: readonly string[] } {
  const { source } = input;
  const original =
    source.workflow === "review-documentation" && source.status !== "succeeded"
      ? source.reviewScope
        ? retainedOperatorReviewTargets(source)
        : input.wholeSetPaths
      : undefined;
  if (!original) {
    throw new Error(
      "This saved run has no intact review scope to narrow. Inspect it and start a new explicit request.",
    );
  }
  if (source.retainedEvidenceBindings || source.changeSources?.length) {
    throw new Error(
      "This saved review bound external change evidence. Select those sources again explicitly before starting a narrower batch.",
    );
  }
  if (
    input.repositoryPath !== source.repository.sourcePath ||
    input.revision !== source.repository.revision ||
    input.instruction !== source.instruction
  ) {
    throw new Error(
      "Rescope must keep the saved review's checkout, exact revision, and original instruction.",
    );
  }
  const originalSet = new Set(original);
  const selected = [...new Set(input.targetPaths)].sort();
  if (
    selected.length === 0 ||
    selected.length >= originalSet.size ||
    selected.some((path) => !originalSet.has(path))
  ) {
    throw new Error(
      "Rescope requires a nonempty proper subset of the saved review's admitted pages; model advice cannot add a target.",
    );
  }
  return {
    targetPaths: selected,
    remainingPaths: original.filter((path) => !selected.includes(path)),
  };
}
