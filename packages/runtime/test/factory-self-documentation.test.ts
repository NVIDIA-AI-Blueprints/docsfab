// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  authorizeLocalUserPublication,
  createDeliveryRequest,
  createLocalUserPublicationAuthorityValidator,
  deliveryKeyForRequest,
  localUserPublicationPlanSha256,
  type LocalUserPublicationPlan,
} from "../src/delivery/index.js";

const HOST = "gitlab.example.test";
const PROJECT = 437040;
const REPOSITORY = "tech-docs/agents/example";
const SOURCE = "docsfab/reviewed-candidate";
const H = "a".repeat(40);
const K = "b".repeat(40);
const NOW = "2026-09-14T16:00:00.000Z";
const EXPIRES = "2026-09-14T16:15:00.000Z";

function plan(): LocalUserPublicationPlan {
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-local-user-gitlab-publication-plan" as const,
    deliveryMode: "local-user" as const,
    authorityBasis: "interactive-once" as const,
    run: { id: "req-743", recordSha256: "f".repeat(64) },
    project: { id: PROJECT, host: HOST, path: REPOSITORY },
    remote: { name: "origin", transport: "https" as const },
    identity: {
      git: "configured" as const,
      gitIdentitySha256: "0".repeat(64),
      gitlabUsername: "operator",
    },
    baseRevision: H,
    targetBranch: { name: "main", protected: true },
    proposedSourceBranch: SOURCE,
    patch: {
      format: "git-diff" as const,
      sha256: "6".repeat(64),
      byteLength: 1,
      changedFileCount: 1,
    },
    validationCommand: "npm test",
    mergeRequest: { draft: true as const },
    fallback: { mode: "patch-only" as const, preserved: true as const },
    checks: {
      repository: "passed" as const,
      remote: "passed" as const,
      revision: "current" as const,
      gitIdentity: "configured" as const,
      gitlabAuthentication: "authenticated" as const,
      pushAccess: "allowed" as const,
      sourceBranch: "unprotected" as const,
    },
  };
  return Object.freeze({ ...body, sha256: localUserPublicationPlanSha256(body) });
}

function request(candidateTreeObjectId: string) {
  return createDeliveryRequest({
    trigger: "interactive",
    intent: "create-draft-mr",
    authorityBasis: "interactive-once",
    controller: "one-shot",
    logicalRequestId: "req-743",
    mergeRequestIid: null,
    binding: {
      host: HOST,
      projectId: PROJECT,
      repository: REPOSITORY,
      baseRevision: H,
      headRevision: K,
      patchDigestSha256: "6".repeat(64),
      allowedPaths: ["docs/guide.md"],
      candidate: {
        treeObjectId: candidateTreeObjectId,
        targetManifestSha256: "5".repeat(64),
        eligibilityReceiptSha256: "1".repeat(64),
      },
      protection: {
        defaultBranch: "main",
        sourceBranch: SOURCE,
        sourceProtected: false,
        targetProtected: true,
        sourceIsDefault: false,
      },
      grant: { version: 1, tier: "contribute", updateExistingMrEnabled: false },
    },
  });
}

describe("factory self-documentation delivery authority", () => {
  it("consumes the actual process-local interactive-once capability at current time", () => {
    const publicationPlan = plan();
    const authorization = authorizeLocalUserPublication({
      plan: publicationPlan,
      confirmedPlanSha256: publicationPlan.sha256,
      command: "publish",
      currentTime: new Date(NOW),
      expiresAt: EXPIRES,
    });
    const validator = createLocalUserPublicationAuthorityValidator();

    expect(() =>
      validator.assertCurrent({
        plan: publicationPlan,
        authorization,
        now: new Date(NOW),
      }),
    ).not.toThrow();
    expect(() =>
      validator.assertCurrent({
        plan: publicationPlan,
        authorization,
        now: new Date(EXPIRES),
      }),
    ).toThrow(/authorization-expired/);
  });

  it("binds candidate tree and receipt identities into request and replay keys", () => {
    const first = request("2".repeat(40));
    const replay = request("2".repeat(40));
    const substituted = request("3".repeat(40));

    expect(replay.requestSha256).toBe(first.requestSha256);
    expect(deliveryKeyForRequest(replay).keySha256).toBe(deliveryKeyForRequest(first).keySha256);
    expect(substituted.requestSha256).not.toBe(first.requestSha256);
    expect(deliveryKeyForRequest(substituted).keySha256).not.toBe(
      deliveryKeyForRequest(first).keySha256,
    );
  });
});
