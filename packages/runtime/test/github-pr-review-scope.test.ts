// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { GithubPrManifestRow } from "../src/inputs/adapters/github-pr-objects.js";
import type { RepositoryDiscoveryInventoryV1 } from "../src/repository/inventory.js";

// The unit oracle supplies already authenticated facts. The installed CLI test
// exercises the provider's live minted-descriptor gate.
vi.mock("../src/inputs/adapters/github-pr-provider.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/inputs/adapters/github-pr-provider.js")>()),
  assertGithubPrBaseDocumentationDescriptor: vi.fn(),
}));

import { projectPrReviewScope } from "../src/workflow-execution/pr-review-scope.js";

const sha = (letter: string) => letter.repeat(40);
const base = {
  schemaVersion: 1 as const,
  kind: "docsfab-github-pr-base-documentation" as const,
  targetRepositoryId: 10,
  B: sha("b"),
  baseTree: sha("a"),
  entries: [],
  descriptorSha256: "c".repeat(64),
};
function inventory(paths: string[]): RepositoryDiscoveryInventoryV1 {
  return {
    status: "complete",
    repositoryRevision: sha("h"),
    coverage: { structure: { status: "complete" }, text: { status: "complete" } },
    files: paths.map((path) => ({ path, kind: "regular" })),
    documents: paths.map((path) => ({ path, candidateAudience: "public" })),
  } as RepositoryDiscoveryInventoryV1;
}
function row(oldPath: string | null, newPath: string | null): GithubPrManifestRow {
  return {
    status: newPath === null ? "D" : oldPath === null ? "A" : "M",
    oldPath,
    newPath,
    oldMode: "100644",
    newMode: "100644",
    oldId: oldPath ? sha("a") : null,
    newId: newPath ? sha("b") : null,
    content: "regular",
  };
}

describe("host-projected public PR scope", () => {
  it("labels changed-document focus and retains separate B context", () => {
    const result = projectPrReviewScope({
      manifest: [row("docs/one.md", "docs/one.md")],
      headInventory: inventory(["docs/one.md", "docs/two.mdx"]),
      baseDocumentation: base,
    });
    expect(result.impact).toBe("changed-documentation");
    expect(result.scope.targetPaths).toEqual(["docs/one.md"]);
    expect(result.scope.corpusFileCount).toBe(2);
    expect(result.baseDocumentationDescriptorSha256).toBe(base.descriptorSha256);
  });

  it("widens code-only changes and deletions to surviving documentation", () => {
    const headInventory = inventory(["docs/one.md", "docs/two.mdx"]);
    const code = projectPrReviewScope({
      manifest: [row("src/index.ts", "src/index.ts")],
      headInventory,
      baseDocumentation: base,
    });
    expect(code.scope.targetPaths).toEqual(["docs/one.md", "docs/two.mdx"]);
    expect(code.impact).toBe("documentation-set-uncertain");
    expect(code.limitations).toContainEqual(expect.stringContaining("no no-impact conclusion"));
    const deletion = projectPrReviewScope({
      manifest: [row("docs/deleted.md", null)],
      headInventory,
      baseDocumentation: base,
    });
    expect(deletion.deletedDocumentationPaths).toEqual(["docs/deleted.md"]);
    expect(deletion.scope.targetPaths).toEqual(["docs/one.md", "docs/two.mdx"]);
    expect(deletion.limitations).toContainEqual(expect.stringContaining("M-before"));
  });

  it("keeps RST-only changes uncertain without naming unsupported RST pages as reviewed", () => {
    const projected = projectPrReviewScope({
      manifest: [row("docs/manual.rst", "docs/manual.rst")],
      headInventory: inventory(["docs/one.md", "docs/manual.rst"]),
      baseDocumentation: base,
    });
    expect(projected.changedDocumentationPaths).toEqual([]);
    expect(projected.impact).toBe("documentation-set-uncertain");
    expect(projected.scope.targetPaths).toEqual(["docs/one.md"]);
    expect(projected.scope.corpusFileCount).toBe(1);
    expect(projected.limitations).toContainEqual(
      expect.stringContaining("no no-impact conclusion"),
    );
  });

  it("widens incomplete H inventory and declares omitted impact unknown", () => {
    const projected = projectPrReviewScope({
      manifest: [row("docs/one.md", "docs/one.md")],
      headInventory: { ...inventory(["docs/one.md", "docs/two.md"]), status: "incomplete" },
      baseDocumentation: base,
    });
    expect(projected.scope.targetPaths).toEqual(["docs/one.md", "docs/two.md"]);
    expect(projected.impact).toBe("documentation-set-uncertain");
    expect(projected.limitations).toContainEqual(
      expect.stringContaining("omitted impact remains unknown"),
    );
  });
});
