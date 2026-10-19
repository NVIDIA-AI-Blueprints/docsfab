// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  assertLocalUserPublicationPlan,
  assertScmDeliveryRecordShape,
  authorizeLocalUserPublication,
  createScmDeliveryRecord,
  localUserGitIdentitySha256,
  localUserPublicationPlanSha256,
  LocalUserPublicationPreflightError,
  ScmDeliveryContractError,
  type LocalUserPublicationPlanV1,
} from "../src/delivery/index.js";
import { parseGitLabRemote } from "../src/delivery/preflight.js";

const PATCH_BYTES = Buffer.from("diff --git a/docs/a.md b/docs/a.md\n", "utf8");

function plan(host: string): LocalUserPublicationPlanV1 {
  const candidate: LocalUserPublicationPlanV1 = {
    schemaVersion: 1,
    kind: "docsfab-local-user-gitlab-publication-plan",
    deliveryMode: "local-user",
    authorityBasis: "interactive-once",
    run: { id: "run-1", recordSha256: "d".repeat(64) },
    project: { id: 42, host, path: "group/docs" },
    remote: { name: "origin", transport: "ssh" },
    identity: {
      git: "configured",
      gitIdentitySha256: localUserGitIdentitySha256("Maintainer", "maintainer@example.test"),
      gitlabUsername: "maintainer",
    },
    baseRevision: "a".repeat(40),
    targetBranch: { name: "main", protected: true },
    proposedSourceBranch: "docsfab/run-1-aaaaaaaaaaaa",
    patch: {
      format: "git-diff",
      sha256: createHash("sha256").update(PATCH_BYTES).digest("hex"),
      byteLength: PATCH_BYTES.byteLength,
      changedFileCount: 1,
    },
    validationCommand: "npm run check",
    mergeRequest: { draft: true },
    fallback: { mode: "patch-only", preserved: true },
    checks: {
      repository: "passed",
      remote: "passed",
      revision: "current",
      gitIdentity: "configured",
      gitlabAuthentication: "authenticated",
      pushAccess: "allowed",
      sourceBranch: "unprotected",
    },
    sha256: "0".repeat(64),
  };
  candidate.sha256 = localUserPublicationPlanSha256(candidate);
  return candidate;
}

function refusal(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("delivery GitLab host grammar", () => {
  it("keeps a mixed-case host in the plan and record and refuses an empty label or a single label", () => {
    const mixed = plan("GitLab.Example.test");
    expect(() => assertLocalUserPublicationPlan(mixed)).not.toThrow();
    const record = createScmDeliveryRecord({
      plan: mixed,
      authorization: authorizeLocalUserPublication({
        plan: mixed,
        confirmedPlanSha256: mixed.sha256,
        command: "publish",
      }),
      createdAt: "2026-08-04T00:00:00.000Z",
    });
    expect(record.repository.host).toBe("GitLab.Example.test");
    expect(assertScmDeliveryRecordShape(structuredClone(record))).toEqual(record);

    for (const host of ["gitlab..example.test", "gitlab"]) {
      const planRefusal = refusal(() => assertLocalUserPublicationPlan(plan(host)));
      expect(planRefusal, host).toBeInstanceOf(LocalUserPublicationPreflightError);
      expect((planRefusal as LocalUserPublicationPreflightError).code).toBe("invalid-input");
      const malformed = structuredClone(record);
      malformed.repository.host = host;
      const recordRefusal = refusal(() => assertScmDeliveryRecordShape(malformed));
      expect(recordRefusal, host).toBeInstanceOf(ScmDeliveryContractError);
      expect((recordRefusal as ScmDeliveryContractError).code).toBe("invalid-record");
    }
  });

  it("accepts a mixed-case SSH remote host and refuses a malformed one", () => {
    expect(parseGitLabRemote("git@GitLab.Example.test:group/docs.git")).toEqual({
      host: "gitlab.example.test",
      projectPath: "group/docs",
      transport: "ssh",
    });
    for (const remote of [
      "git@gitlab..example.test:group/docs.git",
      "git@gitlab-.example.test:group/docs.git",
      "git@gitlab:group/docs.git",
    ]) {
      const error = refusal(() => parseGitLabRemote(remote));
      expect(error, remote).toBeInstanceOf(LocalUserPublicationPreflightError);
      expect((error as LocalUserPublicationPreflightError).code).toBe("unsupported-remote");
    }
  });
});
