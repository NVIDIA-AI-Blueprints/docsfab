// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  routeRepositoryEventDelivery,
  type RepositoryEventRoutingInputV1,
} from "../src/delivery/repository-event-routing.js";
import { routeRepositoryEventDelivery as routeFromHostSafeBarrel } from "../src/delivery/host-routing.js";

const C = "a".repeat(40);
const H = "b".repeat(40);
const SHA = (character: string): string => character.repeat(64);

function input(
  overrides: Partial<RepositoryEventRoutingInputV1> = {},
): RepositoryEventRoutingInputV1 {
  return {
    source: {
      logicalRequestId: "gitlab-pipeline-project-437040-91",
      inputManifestSha256: SHA("1"),
      outcomeInputManifestSha256: SHA("1"),
      sourceManifestSha256: SHA("2"),
      host: "gitlab.example.com",
      projectId: 437040,
      baseRevision: C,
      headRevision: H,
      requestedIntent: "create-draft-mr",
    },
    target: {
      repository: "group/project",
      patchDigestSha256: SHA("3"),
      // The source event may change src/default.ts while the reviewed
      // documentation candidate changes docs/default.md.
      allowedPaths: ["docs/default.md"],
      defaultBranch: "main",
      sourceBranch: "docsfab/event-91",
      sourceProtected: false,
      targetProtected: true,
      sourceIsDefault: false,
      grantVersion: 7,
    },
    grant: {
      decision: "allow",
      reason: "allowed",
      host: "gitlab.example.com",
      projectId: 437040,
      grantVersion: 7,
      tier: "contribute",
      status: "active",
      allowedOperations: [
        "read-revision",
        "create-or-update-summary-note",
        "push-namespaced-unprotected-non-default-branch",
        "create-or-reuse-draft-mr",
      ],
    },
    mergeRequests: [],
    candidate: {
      disposition: "eligible",
      sourceManifestSha256: SHA("2"),
      baseRevision: C,
      headRevision: H,
      patchSha256: SHA("3"),
      patchPaths: ["docs/default.md"],
      candidateTreeObjectId: "c".repeat(40),
      targetManifestSha256: SHA("4"),
      eligibilityReceiptSha256: SHA("5"),
    },
    ...overrides,
  };
}

describe("repository-event delivery routing", () => {
  it("selects a draft only for exact Contribute and eligible candidate evidence", () => {
    const decision = routeRepositoryEventDelivery(input());
    expect(decision.intent).toBe("create-draft-mr");
    expect(decision.reason).toBe("create-draft-mr");
    expect(decision.candidate?.patchPaths).toEqual(["docs/default.md"]);
  });

  it("selects an existing-MR comment only for exact Review evidence and one MR", () => {
    const base = input();
    const decision = routeRepositoryEventDelivery(
      input({
        source: { ...base.source, requestedIntent: "comment-existing-mr" },
        grant: { ...base.grant, tier: "review" },
        mergeRequests: [
          { iid: 12, host: base.source.host, projectId: base.source.projectId, headRevision: H },
        ],
        candidate: null,
      }),
    );
    expect(decision).toEqual({
      intent: "comment-existing-mr",
      reason: "comment-existing-mr",
      mergeRequestIid: 12,
      candidate: null,
    });
  });

  it("keeps an explicit artifact-only request artifact-only", () => {
    const base = input();
    expect(
      routeRepositoryEventDelivery(
        input({ source: { ...base.source, requestedIntent: "artifact-only" } }),
      ),
    ).toEqual({
      intent: "artifact-only",
      reason: "requested-artifact-only",
      mergeRequestIid: null,
      candidate: null,
    });
  });

  it("requires the trusted outcome to bind the exact admitted packet", () => {
    const base = input();
    expect(
      routeRepositoryEventDelivery(
        input({
          source: { ...base.source, outcomeInputManifestSha256: SHA("9") },
        }),
      ).reason,
    ).toBe("event-evidence-binding-mismatch");
  });

  it("rejects an unknown requested intent at the exported boundary", () => {
    const base = input();
    expect(() =>
      routeRepositoryEventDelivery(
        input({
          source: { ...base.source, requestedIntent: "merge" as never },
        }),
      ),
    ).toThrowError("Repository event routing requires one supported requested delivery intent.");
  });

  it("falls back for absent, wrong, stale, or insufficient grants", () => {
    const base = input();
    for (const grant of [
      { ...base.grant, decision: "deny" as const, reason: "default-deny" },
      { ...base.grant, host: "gitlab.other.example" },
      { ...base.grant, grantVersion: 8 },
      { ...base.grant, status: "revoked" as const },
      { ...base.grant, tier: "review" as const },
      { ...base.grant, allowedOperations: ["create-or-reuse-draft-mr"] },
    ]) {
      expect(routeRepositoryEventDelivery(input({ grant })).intent).toBe("artifact-only");
    }
  });

  it("falls back when an existing MR is missing, ambiguous, or drifted", () => {
    const base = input();
    const source = { ...base.source, requestedIntent: "comment-existing-mr" as const };
    const grant = { ...base.grant, tier: "review" as const };
    const exact = { iid: 12, host: source.host, projectId: source.projectId, headRevision: H };
    expect(routeRepositoryEventDelivery(input({ source, grant, mergeRequests: [] })).reason).toBe(
      "merge-request-missing",
    );
    expect(
      routeRepositoryEventDelivery(
        input({ source, grant, mergeRequests: [exact, { ...exact, iid: 13 }] }),
      ).reason,
    ).toBe("merge-request-ambiguous");
    expect(
      routeRepositoryEventDelivery(
        input({ source, grant, mergeRequests: [{ ...exact, headRevision: "d".repeat(40) }] }),
      ).reason,
    ).toBe("merge-request-binding-mismatch");
  });

  it("falls back for missing, ineligible, or drifted candidate evidence", () => {
    const base = input();
    expect(routeRepositoryEventDelivery(input({ candidate: null })).reason).toBe(
      "candidate-missing",
    );
    expect(
      routeRepositoryEventDelivery(
        input({ candidate: { ...base.candidate!, disposition: "ineligible" } }),
      ).reason,
    ).toBe("candidate-ineligible");
    for (const candidate of [
      { ...base.candidate!, sourceManifestSha256: SHA("9") },
      { ...base.candidate!, baseRevision: "d".repeat(40) },
      { ...base.candidate!, headRevision: "d".repeat(40) },
      { ...base.candidate!, patchSha256: SHA("9") },
      { ...base.candidate!, patchPaths: ["docs/other.md"] },
    ]) {
      expect(routeRepositoryEventDelivery(input({ candidate })).reason).toBe(
        "candidate-binding-mismatch",
      );
    }
  });

  it("does not add process-local replay suppression", () => {
    const first = routeRepositoryEventDelivery(input());
    const replay = routeRepositoryEventDelivery(input());
    expect(first).toEqual(replay);
    expect(replay.intent).toBe("create-draft-mr");
  });

  it("re-exports the same selector from the host-safe barrel", () => {
    expect(routeFromHostSafeBarrel).toBe(routeRepositoryEventDelivery);
  });
});
