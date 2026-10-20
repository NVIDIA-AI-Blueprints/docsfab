// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  UPDATE_EXISTING_MR_AUTHORITY_KIND,
  UPDATE_EXISTING_MR_KIND,
  UpdateExistingMrError,
  createUpdateExistingMrAuthority,
  createUpdateExistingMrRequest,
  decodeUpdateExistingMrRequest,
  type UpdateExistingMrAuthorityPolicyV1,
  type UpdateExistingMrGrantV1,
  type UpdateExistingMrRequestInputV1,
  type UpdateExistingMrScmObservationV1,
} from "../../../src/delivery/update-existing-mr/index.js";
import { evaluateUpdateExistingMr } from "../../../src/delivery/update-existing-mr/index.js";

const HEAD = "a".repeat(40);
const ID = "b".repeat(64);
const PATCH = "c".repeat(64);

function input(
  overrides: Partial<UpdateExistingMrRequestInputV1> = {},
): UpdateExistingMrRequestInputV1 {
  return {
    project: { host: "gitlab.example.com", projectId: 7, repository: "group/docs" },
    mergeRequest: {
      iid: 12,
      sourceProjectId: 7,
      sourceBranch: "docsfab/topic",
      targetBranch: "main",
      expectedHeadSha: HEAD,
      sourceOwnerIdentity: "example-user",
    },
    patch: { sha256: PATCH, changedPaths: ["docs/guide.md"] },
    policyVersion: "A+1",
    requesterIdentitySha256: ID,
    logicalRequestId: "request-1",
    forcePush: false,
    ...overrides,
  };
}
function policy(): UpdateExistingMrAuthorityPolicyV1 {
  return {
    host: "gitlab.example.com",
    projectId: 7,
    mergeRequestIid: 12,
    sourceProjectId: 7,
    sourceBranch: "docsfab/topic",
    targetBranch: "main",
    expectedHeadSha: HEAD,
    sourceOwnerIdentity: "example-user",
    requesterIdentitySha256: ID,
    policyVersion: "A+1",
  };
}
function observation(
  overrides: Partial<UpdateExistingMrScmObservationV1> = {},
): UpdateExistingMrScmObservationV1 {
  return {
    host: "gitlab.example.com",
    projectId: 7,
    sourceProjectId: 7,
    mergeRequestIid: 12,
    sourceBranch: "docsfab/topic",
    targetBranch: "main",
    headSha: HEAD,
    defaultBranch: "main",
    sourceProtected: false,
    sourceIsDefault: false,
    sourceOwnerIdentity: "example-user",
    ...overrides,
  };
}
function grant(overrides: Partial<UpdateExistingMrGrantV1> = {}): UpdateExistingMrGrantV1 {
  return {
    host: "gitlab.example.com",
    projectId: 7,
    mergeRequestIid: 12,
    sourceBranch: "docsfab/topic",
    targetBranch: "main",
    expectedHeadSha: HEAD,
    requesterIdentitySha256: ID,
    policyVersion: "A+1",
    grantVersion: 3,
    enabled: true,
    operation: "update-existing-mr-source-branch",
    ...overrides,
  };
}

describe("update-existing-MR runtime contracts", () => {
  it("seals an exact target and permits only the complete A+1 intersection", () => {
    const request = createUpdateExistingMrRequest(input());
    const decision = evaluateUpdateExistingMr({
      request,
      authority: createUpdateExistingMrAuthority(policy()),
      grant: grant(),
      observation: observation(),
    });
    expect(decision.decision).toBe("allow");
    expect(decision.reason).toBe("allowed");
    expect(decision.fallback.visible).toBe(true);
  });

  it.each([
    ["missing authority", {}, "authority-required"],
    ["missing grant", {}, "grant-required"],
    ["fork", { sourceProjectId: 8 }, "fork-not-allowed"],
    ["other owner", { sourceOwnerIdentity: "other" }, "owner-not-allowed"],
    ["protected branch", { sourceProtected: true }, "protected-branch"],
    ["default branch", { sourceIsDefault: true }, "default-branch"],
    ["stale head", { headSha: "d".repeat(40) }, "stale-head"],
  ] as const)("falls back visibly for %s", (name, change, reason) => {
    const request = createUpdateExistingMrRequest(input());
    const result = evaluateUpdateExistingMr({
      request,
      authority: name === "missing authority" ? null : createUpdateExistingMrAuthority(policy()),
      grant: name === "missing grant" ? null : grant(),
      observation: observation(change),
    });
    expect(result.decision).toBe("deny");
    expect(result.reason).toBe(reason);
    expect(result.fallback.mode).toBe("comment-only-evaluation");
  });

  it("rejects force push at request construction", () => {
    expect(() => createUpdateExistingMrRequest(input({ forcePush: true as never }))).toThrowError(
      new UpdateExistingMrError("force-push-forbidden"),
    );
  });

  it("keeps the sealed request consume schema and a distinct runtime authority kind", () => {
    expect(UPDATE_EXISTING_MR_KIND).toBe("docsfab-update-existing-mr-request");
    expect(UPDATE_EXISTING_MR_AUTHORITY_KIND).toBe("docsfab-update-existing-mr-authority");
    expect(UPDATE_EXISTING_MR_AUTHORITY_KIND).not.toBe("docsfab-update-existing-mr-host-authority");
    const request = createUpdateExistingMrRequest(input());
    expect(decodeUpdateExistingMrRequest(request)).toEqual(request);
  });
  it("binds the observation to the approved host", () => {
    const result = evaluateUpdateExistingMr({
      request: createUpdateExistingMrRequest(input()),
      authority: createUpdateExistingMrAuthority(policy()),
      grant: grant(),
      observation: observation({ host: "gitlab.example.net" }),
    });
    expect(result.reason).toBe("project-mismatch");
  });
});
