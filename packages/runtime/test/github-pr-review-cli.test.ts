// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { parseRunArguments } from "../src/cli/run-arguments.js";
import { executeRunRequest } from "../src/cli/run-request.js";
import { createChangeRequestRef } from "../src/inputs/change-request.js";
import { canonicalDigest } from "../src/contract-kit/index.js";
import { projectSourceRequestContext } from "../src/inputs/source-evidence.js";
import { withSelectedRunWorkspace } from "../src/cli/run/pr-workspace.js";
import { decodePrReviewBasisBinding } from "../src/inputs/pr-review-basis-binding.js";

const pr = "https://github.com/example/docs/pull/42";

describe("public GitHub PR review CLI", () => {
  it("keeps the PR selection distinct from the checkout change resolver", () => {
    const request = parseRunArguments([
      "review-documentation",
      "--pr",
      pr,
      "--source",
      "docs/start.md",
    ]);
    expect(request.githubPrReview).toMatchObject({
      kind: "github-pr-review-input",
      url: pr,
      selector: { source: "github-pull-request", number: 42 },
    });
    expect(request.sourcePaths).toEqual(["docs/start.md"]);
    expect(request.changeSource).toBeUndefined();
  });

  it.each([
    ["--repo", "/any/repo"],
    ["--revision", "HEAD"],
    ["--remote", "origin"],
    ["--comment-mr", "https://example.com/mr/1"],
    ["--resume-from", "saved"],
    ["--change", "HEAD~1..HEAD"],
    ["--draft-mr"],
    ["--allow-write"],
    ["--patch-only"],
  ])("refuses %s before acquisition", (...flag) => {
    expect(() => parseRunArguments(["review-documentation", "--pr", pr, ...flag])).toThrow();
  });

  it("refuses a second selector and a GitHub URL under --mr", () => {
    expect(() => parseRunArguments(["review-documentation", "--pr", pr, "--pr", pr])).toThrow();
    expect(() => parseRunArguments(["review-documentation", "--mr", pr])).toThrow();
  });

  it("refuses GitLab delivery preview on a PR before acquisition", () => {
    expect(() =>
      parseRunArguments([
        "review-documentation",
        "--pr",
        pr,
        "--review-delivery",
        "preview",
        "--review-delivery-target",
        "https://gitlab.example.test/team/docs/-/merge_requests/7",
      ]),
    ).toThrow();
  });

  it("refuses a prepared checkout review before acquiring a PR basis", async () => {
    const request = parseRunArguments(["review-documentation", "--pr", pr]);
    const consume = vi.fn();
    await expect(
      withSelectedRunWorkspace({
        request,
        workspaceRevision: "HEAD",
        workspaceRoot: "/unused-pr-root",
        options: { preparedReviewChange: {} as never },
        consume,
      }),
    ).rejects.toThrow(/checkout-bound/u);
    expect(consume).not.toHaveBeenCalled();
  });

  it("prints an unresolved plan without touching provider or workspace", async () => {
    const request = parseRunArguments(["review-documentation", "--pr", pr, "--dry-run", "--json"]);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await executeRunRequest(request);
      expect(log).toHaveBeenCalledOnce();
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
        kind: "docsfab-dry-run",
        workflow: "review-documentation",
        wouldWrite: false,
        wouldPublish: false,
        plannedPrBasis: { state: "unresolved", url: pr },
      });
    } finally {
      log.mockRestore();
    }
  });

  it("binds M/B/H and the manifest in V5 while preserving the old projection", () => {
    const ref = createChangeRequestRef({
      provider: "github",
      canonicalHost: "github.com",
      targetRepositoryId: "10",
      objectKind: "pull-request",
      nativeChangeId: "42",
    });
    const basisBody = {
      schemaVersion: 1,
      kind: "docsfab-pr-review-basis-binding",
      ref,
      targetRepositoryId: "10",
      headRepositoryId: "11",
      B: "b".repeat(40),
      M: "c".repeat(40),
      H: "d".repeat(40),
      baseTree: "e".repeat(40),
      headTree: "f".repeat(40),
      manifestSha256: "a".repeat(64),
      headEntriesSha256: "b".repeat(64),
      baseDocumentationDescriptorSha256: "c".repeat(64),
    };
    const basis = { ...basisBody, basisSha256: canonicalDigest(basisBody) };
    for (const digestField of [
      "manifestSha256",
      "headEntriesSha256",
      "baseDocumentationDescriptorSha256",
    ] as const) {
      const truncatedBody = { ...basisBody, [digestField]: "a".repeat(40) };
      expect(() =>
        decodePrReviewBasisBinding({
          ...truncatedBody,
          basisSha256: canonicalDigest(truncatedBody),
        }),
      ).toThrow(/saved PR review basis is malformed/u);
    }
    const request = { workflow: "review-documentation", allowWrite: false };
    const resolved = {
      runId: "review-run",
      workspaceIdentitySha256: "e".repeat(64),
      repository: { identitySha256: "f".repeat(64), revision: "d".repeat(40) },
    };
    const prior = projectSourceRequestContext(request, resolved);
    expect(projectSourceRequestContext(request, resolved, { projectionVersion: 1 })).toBe(prior);
    const bound = projectSourceRequestContext({ ...request, prReviewBasis: basis }, resolved);
    expect(bound).not.toBe(prior);
    const otherBody = { ...basisBody, H: "1".repeat(40) };
    expect(
      projectSourceRequestContext(
        {
          ...request,
          prReviewBasis: { ...otherBody, basisSha256: canonicalDigest(otherBody) },
        },
        resolved,
      ),
    ).not.toBe(bound);
    expect(() =>
      projectSourceRequestContext(
        {
          ...request,
          prReviewBasis: { ...basis, H: "1".repeat(40) },
        },
        resolved,
      ),
    ).toThrow();
    expect(() =>
      projectSourceRequestContext({ ...request, prReviewBasis: basis }, resolved, {
        projectionVersion: 4,
      }),
    ).toThrow();
  });
});
