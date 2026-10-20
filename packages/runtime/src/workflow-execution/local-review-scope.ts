// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { canonicalDigest } from "../contract-kit/index.js";
import type { RunReviewScope } from "../execution/contracts.js";
import type { RepositoryDiscoveryInventoryV1 } from "../repository/inventory.js";

export const LOCAL_REVIEW_SCOPE_FAILURES = {
  ambiguous:
    "Review target selection is ambiguous: the instruction mixes named pages with supporting sources, exclusions, or whole-set scope. " +
    "Use --context-path for one page, or name only the pages to review.",
  unrecognized:
    "Review target selection failed: a named page is not a recognized regular documentation file at the selected revision. " +
    "Use repository-relative Markdown paths or --context-path for one page.",
} as const;

function documentationPaths(instruction: string): string[] {
  return instruction
    .split(/[\s`"'<>(),;]+/u)
    .map((token) => token.replace(/[.:]+$/u, "").split("#")[0]!)
    .filter((token) => /\.mdx?$/iu.test(token) && !token.includes("://"))
    .map((path) => path.replace(/^\.\//u, ""));
}

/** The documentation pages a whole-set review covers: public, regular files, sorted. */
export function publicDocumentationPaths(inventory: RepositoryDiscoveryInventoryV1): string[] {
  const regularPaths = new Set(
    inventory.files.filter((file) => file.kind === "regular").map((file) => file.path),
  );
  return inventory.documents
    .filter(
      (document) => document.candidateAudience === "public" && regularPaths.has(document.path),
    )
    .map((document) => document.path)
    .sort();
}

/** Resolve operator-named pages once, before profile selection or inference. */
export function resolveLocalReviewScope(input: {
  instruction?: string;
  sourcePath?: string;
  inventory: RepositoryDiscoveryInventoryV1;
  /** Planner-named pages; `using`/`exclude` cannot replace this bound set. */
  boundPaths?: readonly string[];
}): RunReviewScope | undefined {
  const namedFromInstruction =
    input.sourcePath !== undefined ? [] : documentationPaths(input.instruction ?? "");
  const boundPaths = input.boundPaths
    ? [...new Set(input.boundPaths.map((path) => path.replace(/^\.\//u, "")))].sort()
    : undefined;
  const namedPaths =
    input.sourcePath !== undefined ? [input.sourcePath] : (boundPaths ?? namedFromInstruction);
  if (namedPaths.length === 0) return undefined;
  const supportingSources = (input.instruction ?? "").matchAll(
    /\b(?:using|based on|refer(?:ence|ring)? to|consult|supporting)\b/giu,
  );
  const mixesDocumentationSources = [...supportingSources].some(
    (source) =>
      documentationPaths((input.instruction ?? "").slice(source.index).split(/[.!?](?:\s|$)/u)[0]!)
        .length > 0,
  );
  if (
    input.sourcePath === undefined &&
    boundPaths === undefined &&
    (mixesDocumentationSources ||
      /\b(?:except|exclud\w*|not\s+(?:review\b|[`"']?[^\s]+\.mdx?\b)|without reviewing|(?:entire|whole) (?:documentation|docs)|all (?:documentation|docs))\b/iu.test(
        input.instruction ?? "",
      ))
  ) {
    throw new Error(LOCAL_REVIEW_SCOPE_FAILURES.ambiguous);
  }

  const documents = publicDocumentationPaths(input.inventory);
  const available = new Set(documents);
  const targetPaths = [...new Set(namedPaths.map((path) => path.replace(/^\.\//u, "")))].sort();
  if (targetPaths.some((path) => !available.has(path))) {
    throw new Error(LOCAL_REVIEW_SCOPE_FAILURES.unrecognized);
  }
  const scope = {
    scope: "focused-set" as const,
    reason: "operator-named" as const,
    targetPaths,
    deferredPaths: [],
    corpusFileCount: documents.length,
  };
  return { ...scope, scopeSha256: canonicalDigest(scope) };
}
