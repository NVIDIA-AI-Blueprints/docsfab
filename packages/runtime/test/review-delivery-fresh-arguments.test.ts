// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { parseRunArguments } from "../src/cli/run-arguments.js";
import { assertFreshGitLabSourceBinding } from "../src/cli/review-delivery.js";
import { createSourceBinding } from "../src/inputs/source-evidence.js";
import { sha256 } from "../src/content-ir/canonical.js";

const source = "https://gitlab.example.test/team/docs/-/merge_requests/17";
const base = [
  "review-documentation",
  "--repo",
  ".",
  "--instruction",
  "Review the selected change.",
  "--change",
  source,
];

describe("explicit fresh review delivery argv", () => {
  it("keeps page selection separate from the GitLab destination", () => {
    const request = parseRunArguments([
      ...base,
      "--review-target",
      "docs/guide.md",
      "--review-delivery-target",
      source,
      "--review-delivery",
      "preview",
    ]);
    expect(request.reviewTargetPaths).toEqual(["docs/guide.md"]);
    expect(request.reviewDeliveryTarget).toBe(source);
    expect(request.reviewDelivery).toBe("preview");
    expect(request.allowWrite).toBe(false);
  });

  it("refuses missing intent, unsupported publication, and implicit source authority before execution", () => {
    expect(() => parseRunArguments([...base, "--review-delivery", "preview"])).toThrow(
      "both --review-delivery and --review-delivery-target",
    );
    expect(() =>
      parseRunArguments([
        ...base,
        "--review-delivery-target",
        source,
        "--review-delivery",
        "publish",
      ]),
    ).toThrow("publish is not yet supported");
    expect(() =>
      parseRunArguments([
        ...base,
        "--review-delivery-target",
        source,
        "--review-delivery",
        "unknown",
      ]),
    ).toThrow("Unknown review delivery mode");
    expect(() =>
      parseRunArguments([
        "review-documentation",
        "--repo",
        ".",
        "--instruction",
        "Review.",
        "--review-delivery-target",
        source,
        "--review-delivery",
        "preview",
      ]),
    ).toThrow("one explicit --change or --mr source");
    expect(() =>
      parseRunArguments([
        ...base,
        "--review-delivery-target",
        "!17",
        "--review-delivery",
        "preview",
      ]),
    ).toThrow("full HTTPS GitLab merge-request URL");
  });

  it("refuses a self-consistent but unreferenced binding and an unequal workspace head", () => {
    const head = "a".repeat(40);
    const repository = { identitySha256: sha256("workspace"), revision: head };
    const body = {
      runIdSha256: sha256("run"),
      repository,
      requestSha256: sha256("request"),
      hostPolicySha256: sha256("policy"),
      producerScopeSha256: sha256("scope"),
      parentBindingSha256: null,
      observations: [
        { observationId: "observation-one", observationSha256: sha256("observation") },
      ],
      requiredObservationIds: ["observation-one"],
    };
    const binding = createSourceBinding(body);
    expect(() =>
      assertFreshGitLabSourceBinding({
        binding,
        referenceDigest: binding.bindingSha256,
        repository,
        reviewedHead: head,
      }),
    ).not.toThrow();
    const substituted = createSourceBinding({ ...body, requestSha256: sha256("forged-request") });
    expect(() =>
      assertFreshGitLabSourceBinding({
        binding: substituted,
        referenceDigest: binding.bindingSha256,
        repository,
        reviewedHead: head,
      }),
    ).toThrow("source binding differs");
    expect(() =>
      assertFreshGitLabSourceBinding({
        binding,
        referenceDigest: binding.bindingSha256,
        repository,
        reviewedHead: "b".repeat(40),
      }),
    ).toThrow("source binding differs");
  });
});
