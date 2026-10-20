// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { parseRunArguments } from "../src/cli/run-arguments.js";
import type { RepositoryDiscoveryInventoryV1 } from "../src/repository/inventory.js";
import {
  LOCAL_REVIEW_SCOPE_FAILURES,
  resolveLocalReviewScope,
} from "../src/workflow-execution/local-review-scope.js";

function inventory(paths: readonly string[]): RepositoryDiscoveryInventoryV1 {
  return {
    files: paths.map((path) => ({ kind: "regular" as const, path })),
    documents: paths.map((path) => ({
      path,
      candidateAudience: "public" as const,
    })),
  } as RepositoryDiscoveryInventoryV1;
}

describe("local review scope", () => {
  it("admits an explicit structured review target set only for review workflows", () => {
    const request = parseRunArguments([
      "review-documentation",
      "--review-target",
      "docs/other.md",
      "--review-target",
      "docs/guide.md",
    ]);
    expect(request.reviewTargetPaths).toEqual(["docs/guide.md", "docs/other.md"]);
    expect(() => parseRunArguments(["bootstrap", "--review-target", "docs/guide.md"])).toThrow();
    expect(() =>
      parseRunArguments([
        "review-documentation",
        "--context-path",
        "docs/guide.md",
        "--review-target",
        "docs/other.md",
      ]),
    ).toThrow();
  });

  it("keeps a named review page when its supporting implementation is not another page", () => {
    const fixture = inventory(["docs/quickstart.md", "README.md"]);
    for (const instruction of [
      "Review docs/quickstart.md using src/sprout.mjs as supporting evidence. Do not edit files.",
      "Review docs/quickstart.md. Check against the implementation as supporting evidence.",
      "Review docs/quickstart.md against src/sprout.mjs. Report problems with supporting source evidence. Scope is docs/quickstart.md and src/sprout.mjs. Do not edit files.",
    ]) {
      expect(resolveLocalReviewScope({ inventory: fixture, instruction })?.targetPaths).toEqual([
        "docs/quickstart.md",
      ]);
    }
    for (const instruction of [
      "Review docs/quickstart.md using README.md as supporting evidence.",
      "Review docs/quickstart.md using src/sprout.mjs. Consult README.md as supporting evidence.",
      "Using docs/quickstart.md as supporting evidence, review the whole documentation set.",
      "Review all docs except docs/quickstart.md.",
    ]) {
      expect(() => resolveLocalReviewScope({ inventory: fixture, instruction })).toThrow(
        LOCAL_REVIEW_SCOPE_FAILURES.ambiguous,
      );
    }
  });

  it("requires a page target for URL-only and directory-only instructions", () => {
    const fixture = inventory(["docs/quickstart.md", "docs/reference/setup.md"]);
    expect(
      resolveLocalReviewScope({
        inventory: fixture,
        instruction: "Review https://example.test/docs/quickstart and report findings.",
      }),
    ).toBeUndefined();
    expect(
      resolveLocalReviewScope({
        inventory: fixture,
        instruction: "Review docs/reference and report findings.",
      }),
    ).toBeUndefined();
    expect(
      resolveLocalReviewScope({
        inventory: fixture,
        instruction: "Review docs/quickstart.md and report findings.",
      })?.targetPaths,
    ).toEqual(["docs/quickstart.md"]);
  });

  it("lets planner-bound pages win over using/exclude lexical tokens", () => {
    const fixture = inventory(["README.md", "docs/guide.md", "docs/other.md"]);
    const instruction =
      "Review README.md using docs/other.md. Exclude docs/guide.md from the review.";
    expect(() => resolveLocalReviewScope({ inventory: fixture, instruction })).toThrow(
      LOCAL_REVIEW_SCOPE_FAILURES.ambiguous,
    );
    expect(
      resolveLocalReviewScope({
        inventory: fixture,
        instruction,
        boundPaths: ["docs/guide.md", "./README.md"],
      })?.targetPaths,
    ).toEqual(["README.md", "docs/guide.md"]);
  });

  it("still rejects bound paths that are not recognized documentation files", () => {
    expect(() =>
      resolveLocalReviewScope({
        inventory: inventory(["README.md"]),
        boundPaths: ["missing.md"],
      }),
    ).toThrow(LOCAL_REVIEW_SCOPE_FAILURES.unrecognized);
  });
});
